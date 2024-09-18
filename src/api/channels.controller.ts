import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  SessionApiParam,
  WorkingSessionParam,
} from '@waha/nestjs/params/SessionApiParam';
import {
  Channel,
  CreateChannelRequest,
  ListChannelsQuery,
  NewsletterIdApiParam,
  NewsletterIdOrInviteCodeApiParam,
} from '@waha/structures/channels.dto';

import { SessionManager } from '../core/abc/manager.abc';
import { isNewsletter, WhatsappSession } from '../core/abc/session.abc';

@ApiSecurity('api_key')
@Controller('api/:session/channels')
@ApiTags('📢 Channels')
export class ChannelsController {
  constructor(private manager: SessionManager) {}

  @Get('')
  @SessionApiParam
  @ApiOperation({ summary: 'Get list of know channels' })
  async list(
    @WorkingSessionParam session: WhatsappSession,
    @Query() query: ListChannelsQuery,
  ): Promise<Channel[]> {
    return session.channelsList(query);
  }

  @Post('')
  @SessionApiParam
  @ApiOperation({ summary: 'Create a new channel.' })
  create(
    @WorkingSessionParam session: WhatsappSession,
    @Body() request: CreateChannelRequest,
  ): Promise<Channel> {
    return session.channelsCreateChannel(request);
  }

  @Delete(':id')
  @SessionApiParam
  @NewsletterIdApiParam
  @ApiOperation({ summary: 'Delete the channel.' })
  delete(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ) {
    return session.channelsDeleteChannel(id);
  }

  @Get(':id')
  @SessionApiParam
  @NewsletterIdOrInviteCodeApiParam
  @ApiOperation({
    summary: 'Get the channel info',
    description:
      'You can use either id (123@newsletter) ' +
      'OR invite code (https://www.whatsapp.com/channel/123)',
  })
  get(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ): Promise<Channel> {
    if (isNewsletter(id)) {
      return session.channelsGetChannel(id);
    } else {
      // https://www.whatsapp.com/channel/123 => 123
      const inviteCode = id.split('/').pop();
      return session.channelsGetChannelByInviteCode(inviteCode);
    }
  }

  @Post('follow')
  @SessionApiParam
  @NewsletterIdApiParam
  @ApiOperation({ summary: 'Follow the channel.' })
  follow(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ): Promise<void> {
    return session.channelsFollowChannel(id);
  }

  @Post('unfollow')
  @SessionApiParam
  @NewsletterIdApiParam
  @ApiOperation({ summary: 'Unfollow the channel.' })
  unfollow(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ): Promise<void> {
    return session.channelsUnfollowChannel(id);
  }

  @Post('mute')
  @SessionApiParam
  @NewsletterIdApiParam
  @ApiOperation({ summary: 'Mute the channel.' })
  mute(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ): Promise<void> {
    return session.channelsMuteChannel(id);
  }

  @Post('unmute')
  @SessionApiParam
  @NewsletterIdApiParam
  @ApiOperation({ summary: 'Unmute the channel.' })
  unmute(
    @WorkingSessionParam session: WhatsappSession,
    @Param('id') id: string,
  ): Promise<void> {
    return session.channelsUnmuteChannel(id);
  }
}
