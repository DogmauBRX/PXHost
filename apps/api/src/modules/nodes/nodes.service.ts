import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CreateNodeDto, UpdateNodeDto } from './dto/node.dto';

const ONLINE_THRESHOLD_MS = 45_000;
const DEGRADED_THRESHOLD_MS = 120_000;

/**
 * Derives node health from last_heartbeat_at at READ time rather than
 * relying solely on the stored `health_status` column staying fresh.
 * Architecture doc 3.5 defines online (<45s) / degraded (45-120s) /
 * offline (>120s); a background sweep job that flips stale nodes to
 * "offline" in the database is a later-milestone concern (it matters for
 * things like excluding a node from auto-deploy), but every READ already
 * reflects true freshness regardless of whether that sweep has run yet.
 */
export function deriveHealthStatus(lastHeartbeatAt: Date | null): string {
  if (!lastHeartbeatAt) return 'unknown';
  const age = Date.now() - lastHeartbeatAt.getTime();
  if (age < ONLINE_THRESHOLD_MS) return 'online';
  if (age < DEGRADED_THRESHOLD_MS) return 'degraded';
  return 'offline';
}

// Every query in this service that can return a full node row omits
// controlTokenEnc explicitly (Prisma 6's `omit`) — it is never legitimate
// for this ciphertext to reach an HTTP response, and relying on every
// call site to remember a `select` allowlist is exactly the kind of thing
// that gets forgotten once. The bootstrap/AgentClient code paths that
// actually need it query the field directly with their own narrow
// `select`, never through this service.
const OMIT_CONTROL_TOKEN = { controlTokenEnc: true } as const;

@Injectable()
export class NodesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const nodes = await this.prisma.node.findMany({
      where: { deletedAt: null },
      include: { location: true, _count: { select: { servers: true, allocations: true } } },
      omit: OMIT_CONTROL_TOKEN,
      orderBy: { name: 'asc' },
    });
    return nodes.map((n) => ({ ...n, healthStatus: deriveHealthStatus(n.lastHeartbeatAt) }));
  }

  async get(id: string) {
    const node = await this.prisma.node.findFirst({
      where: { id, deletedAt: null },
      include: { location: true, _count: { select: { servers: true, allocations: true } } },
      omit: OMIT_CONTROL_TOKEN,
    });
    if (!node) throw new NotFoundException('Node not found');
    return { ...node, healthStatus: deriveHealthStatus(node.lastHeartbeatAt) };
  }

  async create(dto: CreateNodeDto) {
    const location = await this.prisma.location.findFirst({ where: { id: dto.locationId, deletedAt: null } });
    if (!location) throw new NotFoundException('Location not found');

    return this.prisma.node.create({
      data: {
        locationId: dto.locationId,
        name: dto.name,
        description: dto.description,
        fqdn: dto.fqdn,
        scheme: dto.scheme ?? 'https',
        daemonPort: dto.daemonPort ?? 8443,
        sftpPort: dto.sftpPort ?? 2022,
        memoryTotalMb: dto.memoryTotalMb,
        memoryReservedMb: dto.memoryReservedMb ?? 0,
        memoryOverallocatePct: dto.memoryOverallocatePct ?? 0,
        diskTotalMb: dto.diskTotalMb,
        diskReservedMb: dto.diskReservedMb ?? 0,
        diskOverallocatePct: dto.diskOverallocatePct ?? 0,
        cpuOverallocatePct: dto.cpuOverallocatePct ?? -1,
        isPublic: dto.isPublic ?? true,
        uploadSizeMb: dto.uploadSizeMb ?? 256,
      },
      omit: OMIT_CONTROL_TOKEN,
    });
  }

  async update(id: string, dto: UpdateNodeDto) {
    await this.get(id);
    return this.prisma.node.update({ where: { id }, data: dto, omit: OMIT_CONTROL_TOKEN });
  }

  async remove(id: string) {
    await this.get(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { nodeId: id } }));
    if (serverCount > 0) throw new ConflictException('Node has servers; transfer or delete them first');
    await this.prisma.node.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
