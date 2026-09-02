import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { KnowledgeBaseProvider } from './kb/kb-provider';
import { AuthorizationModule } from '../authorization/authorization.module';

// Deliberately imports NOTHING that can touch a running server —
// no NodesModule (AgentClient), no FilesModule. The assistant is
// consultative by construction: there is nothing in this module's
// dependency graph capable of starting a container, writing a file, or
// running a console command, regardless of what any AssistantProvider
// (the KB today, an LLM later) decides to say. See AssistantService's
// doc comment.
@Module({
  imports: [AuthorizationModule],
  controllers: [AssistantController],
  providers: [AssistantService, KnowledgeBaseProvider],
})
export class AssistantModule {}
