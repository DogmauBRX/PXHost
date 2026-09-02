import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

class AssistantMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @Length(0, 2000)
  text!: string;
}

// Conversation is stateless server-side (client-features Fase 8 design):
// the client holds the transcript and resends it each turn. `history` is
// optional and the KB provider ignores it entirely — it exists so a
// future LLM adapter has multi-turn context without a wire-format change.
export class AssistantChatDto {
  @IsString()
  serverId!: string;

  @IsString()
  @Length(1, 2000)
  message!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssistantMessageDto)
  history?: AssistantMessageDto[];
}
