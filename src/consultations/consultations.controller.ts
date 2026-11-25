import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConsultationsService } from './consultations.service';
import { CreateConsultationDto, EnrollConsultationDto, ListConsultationsQueryDto, UpdateConsultationDto } from './consultations.dto';

/**
 * Buy and sell virtual consultations.
 *
 *   POST   /consultations              sell one (start, end, price in USD, optional Google Meet link)
 *   GET    /consultations              browse everyone's live ones  ?search= &category= &page= &limit=
 *   GET    /consultations/mine         the ones I am selling
 *   GET    /consultations/enrolled     the ones I paid for (with their Meet links)
 *   GET    /consultations/:id          one consultation (the Meet link only for the owner and paid students)
 *   POST   /consultations/:id/enroll   start the payment: returns a Paystack checkout (authorizationUrl). The place is
 *                                      confirmed once the payment is verified (webhook, or GET /payments/verify/:reference
 *                                      after Paystack redirects back) - nothing is taken from the token wallet.
 *   GET    /consultations/:id/students owner only: who enrolled
 *   PATCH  /consultations/:id          owner only: edit, including adding or changing the Meet link
 *   DELETE /consultations/:id          owner only: cancel (students are refunded to what they paid with)
 *
 * Share link (the seller sends it to people; opening it shows the consultation and lets them enrol):
 *   POST   /consultations/:id/share-link        owner only: create (or fetch) the link -> { shareCode, shareLink }
 *   DELETE /consultations/:id/share-link        owner only: turn the link off (the old link stops working)
 *   GET    /consultations/shared/:code          PUBLIC (no sign-in needed): preview of the consultation, no Meet link
 *   POST   /consultations/shared/:code/enroll   signed-in member: start the Paystack payment, same as /:id/enroll
 */
@Controller('consultations')
export class ConsultationsController {
  constructor(private consultations: ConsultationsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateConsultationDto) {
    return this.consultations.create(userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@CurrentUser('id') userId: string, @Query() query: ListConsultationsQueryDto) {
    return this.consultations.listPublic(userId, query);
  }

  // The two fixed paths below must stay above ':id' so they are not read as ids.
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser('id') userId: string) {
    return this.consultations.listMine(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('enrolled')
  enrolled(@CurrentUser('id') userId: string) {
    return this.consultations.listEnrolled(userId);
  }

  // Shared-link routes: fixed 'shared/...' paths, kept above ':id'.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('shared/:code')
  shared(@CurrentUser('id') userId: string | undefined, @Param('code') code: string) {
    return this.consultations.getShared(userId ?? null, code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('shared/:code/enroll')
  enrollViaShare(@CurrentUser('id') userId: string, @Param('code') code: string, @Body() dto: EnrollConsultationDto) {
    return this.consultations.enrollViaShare(userId, code, dto?.currency);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.consultations.getOne(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/enroll')
  enroll(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: EnrollConsultationDto) {
    return this.consultations.enroll(userId, id, dto?.currency);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/students')
  students(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.consultations.listStudents(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateConsultationDto) {
    return this.consultations.update(userId, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/share-link')
  createShareLink(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.consultations.createShareLink(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/share-link')
  revokeShareLink(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.consultations.revokeShareLink(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.consultations.remove(userId, id);
  }
}
