import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { TICKET_CATEGORY_PRIORITY } from './dto/support.dto';
import type {
  AddSupportMessageDto,
  CreateSupportTicketDto,
  ListAdminSupportTicketsDto,
  UpdateSupportTicketDto,
} from './dto/support.dto';

const TICKET_SUMMARY_INCLUDE = {
  server: { select: { id: true, name: true, shortId: true } },
  user: { select: { id: true, username: true, email: true } },
  messages: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { body: true, isStaff: true, createdAt: true },
  },
  _count: { select: { messages: true } },
};

const TICKET_DETAIL_INCLUDE = {
  server: { select: { id: true, name: true, shortId: true } },
  user: { select: { id: true, username: true, email: true } },
  messages: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      body: true,
      isStaff: true,
      createdAt: true,
      author: { select: { id: true, username: true, globalRole: true } },
    },
  },
};

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async createForUser(userId: string, dto: CreateSupportTicketDto) {
    return this.prisma.withRLS({ userId, isAdmin: false }, async (tx) => {
      if (dto.serverId) {
        const server = await tx.server.findFirst({ where: { id: dto.serverId, ownerId: userId }, select: { id: true } });
        if (!server) throw new NotFoundException('Servidor não encontrado');
      }

      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          serverId: dto.serverId,
          subject: dto.subject.trim(),
          category: dto.category,
          priority: TICKET_CATEGORY_PRIORITY[dto.category],
          messages: {
            create: { authorId: userId, body: dto.message.trim(), isStaff: false },
          },
        },
        include: TICKET_DETAIL_INCLUDE,
      });
      return ticket;
    });
  }

  listForUser(userId: string) {
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.supportTicket.findMany({
        where: { userId },
        include: TICKET_SUMMARY_INCLUDE,
        orderBy: { lastMessageAt: 'desc' },
      }),
    );
  }

  async getForUser(userId: string, id: string) {
    const ticket = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.supportTicket.findFirst({ where: { id, userId }, include: TICKET_DETAIL_INCLUDE }),
    );
    if (!ticket) throw new NotFoundException('Ticket não encontrado');
    return ticket;
  }

  async replyAsUser(userId: string, id: string, dto: AddSupportMessageDto) {
    return this.prisma.withRLS({ userId, isAdmin: false }, async (tx) => {
      const ticket = await tx.supportTicket.findFirst({ where: { id, userId }, select: { id: true, status: true } });
      if (!ticket) throw new NotFoundException('Ticket não encontrado');
      if (ticket.status === 'closed') throw new ConflictException('TICKET_CLOSED: este ticket já foi fechado');

      const now = new Date();
      await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: userId, body: dto.message.trim(), isStaff: false } });
      await tx.supportTicket.update({
        where: { id },
        data: { status: ticket.status === 'waiting_customer' ? 'open' : ticket.status, lastMessageAt: now },
      });
      return tx.supportTicket.findUniqueOrThrow({ where: { id }, include: TICKET_DETAIL_INCLUDE });
    });
  }

  listForAdmin(dto: ListAdminSupportTicketsDto) {
    const q = dto.q?.trim();
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.supportTicket.findMany({
        where: {
          status: dto.status,
          priority: dto.priority,
          ...(q
            ? {
                OR: [
                  { subject: { contains: q, mode: 'insensitive' } },
                  { user: { username: { contains: q, mode: 'insensitive' } } },
                  { user: { email: { contains: q, mode: 'insensitive' } } },
                  { server: { name: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        include: TICKET_SUMMARY_INCLUDE,
        orderBy: { lastMessageAt: 'desc' },
      }),
    );
  }

  async getForAdmin(id: string) {
    const ticket = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.supportTicket.findUnique({ where: { id }, include: TICKET_DETAIL_INCLUDE }),
    );
    if (!ticket) throw new NotFoundException('Ticket não encontrado');
    return ticket;
  }

  async replyAsAdmin(actorId: string, id: string, dto: AddSupportMessageDto) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!ticket) throw new NotFoundException('Ticket não encontrado');
      if (ticket.status === 'closed') throw new ConflictException('TICKET_CLOSED: reabra o ticket antes de responder');

      await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: actorId, body: dto.message.trim(), isStaff: true } });
      await tx.supportTicket.update({ where: { id }, data: { status: 'waiting_customer', lastMessageAt: new Date() } });
      return tx.supportTicket.findUniqueOrThrow({ where: { id }, include: TICKET_DETAIL_INCLUDE });
    });
  }

  async updateAsAdmin(id: string, dto: UpdateSupportTicketDto) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!ticket) throw new NotFoundException('Ticket não encontrado');
      return tx.supportTicket.update({
        where: { id },
        data: {
          priority: dto.priority,
          ...(dto.status
            ? { status: dto.status, closedAt: dto.status === 'closed' ? new Date() : null }
            : {}),
        },
        include: TICKET_DETAIL_INCLUDE,
      });
    });
  }

  async removeAsAdmin(id: string) {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id }, select: { id: true } });
      if (!ticket) throw new NotFoundException('Ticket não encontrado');

      // `support_ticket_messages.ticket_id` has ON DELETE CASCADE, so the
      // ticket conversation is permanently removed with its parent record.
      await tx.supportTicket.delete({ where: { id } });
    });
  }
}
