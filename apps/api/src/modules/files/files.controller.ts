import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { FilesService } from './files.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { WriteFileDto, RenameFileDto, MkdirDto, ChmodDto, CompressDto, DecompressDto, DownloadLinkDto, UploadLinkDto, DeleteFileDto } from './dto/file-ops.dto';

@Controller('api/client/servers/:serverId/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query('path') path = '.') {
    return this.files.list(user, serverId, path);
  }

  @Get('contents')
  read(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query('path') path: string) {
    return this.files.read(user, serverId, path);
  }

  @Put('contents')
  write(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serverId') serverId: string,
    @Query('path') path: string,
    @Body() dto: WriteFileDto,
  ) {
    return this.files.write(user, serverId, path, dto.content);
  }

  @Post('rename')
  rename(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: RenameFileDto) {
    return this.files.rename(user, serverId, dto.from, dto.to);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Query() query: DeleteFileDto) {
    return this.files.delete(user, serverId, query.path, query.recursive === 'true');
  }

  @Post('mkdir')
  @HttpCode(HttpStatus.CREATED)
  mkdir(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: MkdirDto) {
    return this.files.mkdir(user, serverId, dto.path);
  }

  @Post('chmod')
  @HttpCode(HttpStatus.NO_CONTENT)
  chmod(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: ChmodDto) {
    return this.files.chmod(user, serverId, dto.path, dto.mode);
  }

  @Post('compress')
  @HttpCode(HttpStatus.CREATED)
  compress(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: CompressDto) {
    return this.files.compress(user, serverId, dto.paths, dto.dest);
  }

  @Post('decompress')
  decompress(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: DecompressDto) {
    return this.files.decompress(user, serverId, dto.path, dto.dest);
  }

  @Post('download-link')
  downloadLink(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: DownloadLinkDto) {
    return this.files.mintDownloadLink(user, serverId, dto.path);
  }

  @Post('upload-link')
  uploadLink(@CurrentUser() user: AuthenticatedUser, @Param('serverId') serverId: string, @Body() dto: UploadLinkDto) {
    return this.files.mintUploadLink(user, serverId, dto.path, dto.maxBytes);
  }
}
