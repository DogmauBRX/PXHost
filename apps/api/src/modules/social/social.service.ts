import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { toClientServerSummary } from '../servers/server-view';
import { AgentClient } from '../nodes/agent-client.service';
import { CapabilityTokenService } from '../../core/capability-token/capability-token.service';

const CLIENT_MODS_ARCHIVE = '.gxhost-community-client-mods.zip';
const DOWNLOAD_TOKEN_TTL_SECONDS = 60;

const publicUser = { id: true, username: true, firstName: true, lastName: true } as const;

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly agent: AgentClient,
    private readonly capabilityTokens: CapabilityTokenService,
  ) {}

  private pairKey(a: string, b: string) {
    return [a, b].sort().join(':');
  }

  async searchUsers(userId: string, rawQuery: string) {
    const q = rawQuery.trim();
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        isActive: true,
        deletedAt: null,
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: publicUser,
      take: 20,
      orderBy: { username: 'asc' },
    });
    const friendships = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
    });
    return users.map((person) => {
      const friendship = friendships.find((f) => f.requesterId === person.id || f.addresseeId === person.id);
      return {
        ...person,
        friendship: friendship
          ? { id: friendship.id, status: friendship.status, direction: friendship.requesterId === userId ? 'outgoing' : 'incoming' }
          : null,
      };
    });
  }

  async friends(userId: string) {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      include: { requester: { select: publicUser }, addressee: { select: publicUser } },
      orderBy: { createdAt: 'desc' },
    });
    const shaped = rows.map((row) => ({
      id: row.id,
      status: row.status,
      direction: row.requesterId === userId ? 'outgoing' : 'incoming',
      user: row.requesterId === userId ? row.addressee : row.requester,
      createdAt: row.createdAt,
    }));
    return {
      accepted: shaped.filter((row) => row.status === 'accepted'),
      incoming: shaped.filter((row) => row.status === 'pending' && row.direction === 'incoming'),
      outgoing: shaped.filter((row) => row.status === 'pending' && row.direction === 'outgoing'),
    };
  }

  async requestFriend(userId: string, targetId: string) {
    if (userId === targetId) throw new BadRequestException('Você não pode adicionar a si mesmo.');
    const target = await this.prisma.user.findFirst({ where: { id: targetId, isActive: true, deletedAt: null }, select: { id: true } });
    if (!target) throw new NotFoundException('Usuário não encontrado.');
    const pairKey = this.pairKey(userId, targetId);
    const existing = await this.prisma.friendship.findUnique({ where: { pairKey } });
    if (existing) throw new ConflictException(existing.status === 'accepted' ? 'Vocês já são amigos.' : 'Já existe um pedido de amizade.');
    return this.prisma.friendship.create({ data: { pairKey, requesterId: userId, addresseeId: targetId } });
  }

  async acceptFriend(userId: string, friendshipId: string) {
    const row = await this.prisma.friendship.findFirst({ where: { id: friendshipId, addresseeId: userId, status: 'pending' } });
    if (!row) throw new NotFoundException('Pedido de amizade não encontrado.');
    return this.prisma.friendship.update({ where: { id: row.id }, data: { status: 'accepted', acceptedAt: new Date() } });
  }

  async removeFriend(userId: string, friendshipId: string) {
    const row = await this.prisma.friendship.findFirst({
      where: { id: friendshipId, OR: [{ requesterId: userId }, { addresseeId: userId }] },
    });
    if (!row) throw new NotFoundException('Amizade ou pedido não encontrado.');
    await this.prisma.friendship.delete({ where: { id: row.id } });
    return { removed: true };
  }

  async directory(userId: string) {
    const [listings, friendships] = await Promise.all([
      this.prisma.communityServer.findMany({
        include: { owner: { select: publicUser } },
        orderBy: { publishedAt: 'desc' },
        take: 100,
      }),
      this.prisma.friendship.findMany({
        where: { status: 'accepted', OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true },
      }),
    ]);
    const friendIds = new Set(friendships.map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId)));
    return listings.map((listing) => ({ ...listing, isFriend: friendIds.has(listing.ownerId), isOwner: listing.ownerId === userId }));
  }

  async details(listingId: string) {
    const listing = await this.prisma.communityServer.findUnique({
      where: { id: listingId },
      include: { owner: { select: publicUser } },
    });
    if (!listing) throw new NotFoundException('Servidor publicado não encontrado.');
    const modpack = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.modpackInstallation.findFirst({
        where: { serverId: listing.serverId, status: 'completed' },
        orderBy: { completedAt: 'desc' },
        select: {
          source: true,
          projectId: true,
          projectName: true,
          versionName: true,
          minecraftVersion: true,
          loader: true,
          completedAt: true,
        },
      }),
    );
    return { ...listing, modpack };
  }

  async downloadClientFiles(userId: string, listingId: string) {
    const listing = await this.prisma.communityServer.findUnique({ where: { id: listingId }, select: { serverId: true } });
    if (!listing) throw new NotFoundException('Servidor publicado não encontrado.');
    const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findUnique({
        where: { id: listing.serverId },
        select: { id: true, nodeId: true, node: { select: { scheme: true, fqdn: true, daemonPort: true } } },
      }),
    );
    if (!server) throw new NotFoundException('Servidor não encontrado.');
    const mods = await this.agent.listFiles(server.nodeId, server.id, 'mods');
    if (!mods.some((entry) => !entry.isDir)) throw new BadRequestException('Este servidor não possui mods adicionais para download.');
    await this.agent.compress(server.nodeId, server.id, ['mods'], CLIENT_MODS_ARCHIVE);
    const token = this.capabilityTokens.mint({
      serverUuid: server.id,
      nodeUuid: server.nodeId,
      userId,
      cap: 'file.download',
      permissions: [],
      ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
      ctx: { path: CLIENT_MODS_ARCHIVE },
    });
    const target = this.agent.fileTransferUrl(server.node.scheme, server.node.fqdn, server.node.daemonPort, server.id, 'download');
    return {
      url: `${target}?path=${encodeURIComponent(CLIENT_MODS_ARCHIVE)}&token=${token}`,
      filename: 'gxhost-client-mods.zip',
      expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS,
    };
  }

  async myServers(userId: string) {
    const servers = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.server.findMany({
        where: { ownerId: userId },
        include: {
          template: true,
          variables: { where: { variable: { envVariable: 'MINECRAFT_VERSION' } }, select: { value: true }, take: 1 },
          publicRoute: { include: { gateway: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const listings = await this.prisma.communityServer.findMany({ where: { ownerId: userId }, select: { serverId: true, description: true } });
    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    const dnsActive = this.config.get<string>('PUBLIC_GATEWAY_DNS_PROVIDER') === 'powerdns';
    return servers.map((server) => {
      const shaped = toClientServerSummary(server, zone, dnsActive);
      const listing = listings.find((row) => row.serverId === server.id);
      return { id: server.id, name: server.name, status: server.status, publicAddress: shaped.publicAddress, published: Boolean(listing), description: listing?.description ?? '' };
    });
  }

  async publish(userId: string, serverId: string, description: string) {
    const server = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.server.findFirst({
        where: { id: serverId, ownerId: userId },
        include: {
          template: true,
          variables: { where: { variable: { envVariable: 'MINECRAFT_VERSION' } }, select: { value: true }, take: 1 },
          publicRoute: { include: { gateway: true } },
        },
      }),
    );
    if (!server) throw new NotFoundException('Servidor não encontrado.');
    const zone = this.config.get<string>('PUBLIC_GATEWAY_HOSTNAME_ZONE');
    const dnsActive = this.config.get<string>('PUBLIC_GATEWAY_DNS_PROVIDER') === 'powerdns';
    const shaped = toClientServerSummary(server, zone, dnsActive);
    if (!shaped.publicAddress) throw new BadRequestException('Este servidor ainda não possui um endereço público ativo.');
    return this.prisma.communityServer.upsert({
      where: { serverId },
      create: {
        serverId,
        ownerId: userId,
        name: server.name,
        description: description.trim(),
        address: shaped.publicAddress,
        software: shaped.software?.label ?? null,
        version: shaped.minecraftVersion,
      },
      update: {
        name: server.name,
        description: description.trim(),
        address: shaped.publicAddress,
        software: shaped.software?.label ?? null,
        version: shaped.minecraftVersion,
      },
    });
  }

  async unpublish(userId: string, serverId: string) {
    const listing = await this.prisma.communityServer.findFirst({ where: { serverId, ownerId: userId } });
    if (!listing) throw new NotFoundException('Publicação não encontrada.');
    await this.prisma.communityServer.delete({ where: { id: listing.id } });
    return { removed: true };
  }
}
