import { ForbiddenException, Injectable } from '@nestjs/common';
import { ServerAccessService, type AccessActor } from '../authorization/server-access.service';
import type { ListModpackVersionsDto, SearchModpacksDto } from './dto/modpack-query.dto';
import type { ModpackProvider, ModpackSource } from './modpack-provider';
import { ModrinthProvider } from './modrinth.provider';

@Injectable()
export class ModpacksService {
  private readonly providers: Map<ModpackSource, ModpackProvider>;

  constructor(
    private readonly access: ServerAccessService,
    modrinth: ModrinthProvider,
  ) {
    this.providers = new Map([[modrinth.source, modrinth]]);
  }

  async search(actor: AccessActor, serverId: string, query: SearchModpacksDto) {
    await this.assertCanView(actor, serverId);
    return this.provider(query.source).search(query);
  }

  async metadata(actor: AccessActor, serverId: string, source: ModpackSource) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getMetadata();
  }

  async project(actor: AccessActor, serverId: string, source: ModpackSource, projectId: string) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getProject(projectId);
  }

  async versions(actor: AccessActor, serverId: string, source: ModpackSource, projectId: string, filters: ListModpackVersionsDto) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getVersions(projectId, filters);
  }

  private provider(source: ModpackSource): ModpackProvider {
    const provider = this.providers.get(source);
    if (!provider) throw new ForbiddenException('Esta fonte de modpacks ainda não está disponível.');
    return provider;
  }

  private async assertCanView(actor: AccessActor, serverId: string): Promise<void> {
    const { can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
  }
}
