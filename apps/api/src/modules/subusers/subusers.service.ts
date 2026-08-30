import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import { InviteSubuserDto, UpdateSubuserPermissionsDto } from './dto/subuser.dto';

/**
 * Subuser management (architecture doc roadmap M11). Deliberately
 * OWNER-ONLY for v1 — `subusers` RLS (`can_access_server`) would let a
 * subuser with no special grant at all still read/write rows on a server
 * they can access, since RLS is the coarse backstop, not the fine-grained
 * check; this service is what actually restricts invite/permission-edit/
 * removal to the owner, matching Pterodactyl's own convention of never
 * letting a subuser manage other subusers unless the product explicitly
 * grows a delegated 'user.*' story later.
 *
 * Invites auto-accept in v1: `subusers.accepted_at` exists in the schema
 * for a real pending-invite flow, but nothing in the panel today shows a
 * customer their pending invitations, so leaving a freshly-invited
 * subuser stuck at "invited but can't do anything until they find an
 * accept button that doesn't exist" would be strictly worse than
 * granting access immediately. A future milestone can add the
 * notification/accept UI without changing this column's meaning.
 */
@Injectable()
export class SubusersService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async list(userId: string, serverId: string) {
    const { server } = await this.access.resolve(userId, serverId);
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subuser.findMany({
        where: { serverId: server.id },
        select: { id: true, permissions: true, acceptedAt: true, createdAt: true, user: { select: { id: true, username: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async invite(userId: string, serverId: string, dto: InviteSubuserDto) {
    const { server, role } = await this.access.resolve(userId, serverId);
    if (role !== 'owner') throw new ForbiddenException('Only the server owner can invite subusers');
    await this.assertValidPermissions(dto.permissions);

    const invitee = await this.prisma.user.findFirst({ where: { email: dto.email, deletedAt: null } });
    if (!invitee) throw new NotFoundException('No user found with that email');
    if (invitee.id === server.ownerId) throw new ConflictException('The owner cannot be invited as a subuser of their own server');

    const existing = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.subuser.findFirst({ where: { serverId: server.id, userId: invitee.id } }));
    if (existing) throw new ConflictException('That user is already a subuser of this server');

    const created = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subuser.create({
        data: { serverId: server.id, userId: invitee.id, permissions: dto.permissions, invitedBy: userId, acceptedAt: new Date() },
        select: { id: true, permissions: true, acceptedAt: true, createdAt: true, user: { select: { id: true, username: true, email: true } } },
      }),
    );
    await this.audit.record({ action: 'server.subuser.invite', targetType: 'server', targetId: server.id, actorId: userId, metadata: { subuserId: created.id, email: dto.email, permissions: dto.permissions } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.subuser.invite', properties: { subuserId: created.id, email: dto.email } });
    return created;
  }

  async updatePermissions(userId: string, serverId: string, subuserId: string, dto: UpdateSubuserPermissionsDto) {
    const { server, role } = await this.access.resolve(userId, serverId);
    if (role !== 'owner') throw new ForbiddenException('Only the server owner can edit subuser permissions');
    await this.assertValidPermissions(dto.permissions);

    const subuser = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.subuser.findFirst({ where: { id: subuserId, serverId: server.id } }));
    if (!subuser) throw new NotFoundException('Subuser not found');

    const updated = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.subuser.update({
        where: { id: subuser.id },
        data: { permissions: dto.permissions },
        select: { id: true, permissions: true, acceptedAt: true, createdAt: true, user: { select: { id: true, username: true, email: true } } },
      }),
    );
    // Revoked permissions must never keep working off a stale cache
    // (architecture doc 2.5: "invalidated on subuser/... change").
    await this.access.invalidatePermissionCache(subuser.userId, server.id);
    await this.audit.record({ action: 'server.subuser.update', targetType: 'server', targetId: server.id, actorId: userId, metadata: { subuserId: subuser.id, permissions: dto.permissions } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.subuser.update', properties: { subuserId: subuser.id } });
    return updated;
  }

  async remove(userId: string, serverId: string, subuserId: string) {
    const { server, role } = await this.access.resolve(userId, serverId);
    if (role !== 'owner') throw new ForbiddenException('Only the server owner can remove subusers');

    const subuser = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.subuser.findFirst({ where: { id: subuserId, serverId: server.id } }));
    if (!subuser) throw new NotFoundException('Subuser not found');

    await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.subuser.delete({ where: { id: subuser.id } }));
    await this.access.invalidatePermissionCache(subuser.userId, server.id);
    await this.audit.record({ action: 'server.subuser.remove', targetType: 'server', targetId: server.id, actorId: userId, metadata: { subuserId: subuser.id } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.subuser.remove', properties: { subuserId: subuser.id } });
  }

  listPermissionCatalog() {
    return this.prisma.permissionCatalog.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  private async assertValidPermissions(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const rows = await this.prisma.permissionCatalog.findMany({ where: { key: { in: keys } }, select: { key: true } });
    const valid = new Set(rows.map((r) => r.key));
    const invalid = keys.filter((k) => !valid.has(k));
    if (invalid.length > 0) throw new BadRequestException(`Unknown permission key(s): ${invalid.join(', ')}`);
  }
}
