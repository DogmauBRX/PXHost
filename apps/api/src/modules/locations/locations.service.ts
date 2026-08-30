import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.location.findMany({ where: { deletedAt: null }, orderBy: { shortCode: 'asc' } });
  }

  async get(id: string) {
    const loc = await this.prisma.location.findFirst({ where: { id, deletedAt: null } });
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  async create(dto: CreateLocationDto) {
    const existing = await this.prisma.location.findFirst({
      where: { shortCode: { equals: dto.shortCode, mode: 'insensitive' }, deletedAt: null },
    });
    if (existing) throw new ConflictException('shortCode already in use');
    return this.prisma.location.create({ data: dto });
  }

  async update(id: string, dto: UpdateLocationDto) {
    await this.get(id);
    return this.prisma.location.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    const nodeCount = await this.prisma.node.count({ where: { locationId: id, deletedAt: null } });
    if (nodeCount > 0) throw new ConflictException('Location has active nodes; move or remove them first');
    await this.prisma.location.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
