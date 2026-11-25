import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { PostedJob } from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePostedJobDto, ListPostedJobsQueryDto, UpdatePostedJobDto } from './posted-jobs.dto';

/** How many live posts one member may have at once (stops spam; they can delete or wait for a post to expire). */
export const MAX_ACTIVE_POSTS_PER_USER = 20;
/** A post may stay up for at most this long from the moment it is created or its date is changed. */
export const MAX_POST_DAYS = 180;
/** The expiry date must be at least this far ahead, so a post is never created already dead. */
const MIN_LEAD_MS = 10 * 60 * 1000;
/** How often expired posts are deleted. Reads already hide them the moment they expire, so this only tidies the table. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 200;

/**
 * Jobs posted by members: create, read, update and delete your own, browse everyone's live posts, and
 * automatic deletion once a post's expiry date has passed.
 *
 *   - "Live" always means `expiresAt > now`. Every read applies that filter, so an expired post disappears the
 *     instant it expires, even if the sweep has not run yet.
 *   - The sweep (on start-up, then every 10 minutes) deletes the expired rows for good and tells each owner.
 */
@Injectable()
export class PostedJobsService implements OnModuleInit {
  private readonly logger = new Logger(PostedJobsService.name);

  constructor(
    @InjectRepository(PostedJob) private posts: Repository<PostedJob>,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    void this.sweepExpired();
    setInterval(() => void this.sweepExpired(), SWEEP_EVERY_MS).unref();
  }

  // ---------------------------------------------------------------- create

  async create(userId: string, dto: CreatePostedJobDto) {
    assertValidId(userId, 'User');
    this.requireContactMethod(dto.applyUrl, dto.applyEmail);
    const expiresAt = this.parseExpiry(dto.expiresAt);

    const active = await this.posts.count({ where: { ownerId: userId, expiresAt: MoreThan(new Date()) } });
    if (active >= MAX_ACTIVE_POSTS_PER_USER) {
      throw new BadRequestException(`You can have up to ${MAX_ACTIVE_POSTS_PER_USER} live job posts at a time. Delete one or wait for one to expire.`);
    }

    const saved = await this.posts.save(
      this.posts.create({
        ownerId: userId,
        title: dto.title,
        company: dto.company ?? null,
        location: dto.location ?? null,
        jobType: dto.jobType ?? 'CUSTOM',
        description: dto.description,
        applyUrl: dto.applyUrl ?? null,
        applyEmail: dto.applyEmail ?? null,
        salary: dto.salary ?? null,
        isRemote: dto.isRemote ?? false,
        expiresAt,
      }),
    );
    return this.present(saved, userId);
  }

  // ---------------------------------------------------------------- read

  /** The signed-in member's own live posts, newest first. */
  async listMine(userId: string) {
    assertValidId(userId, 'User');
    const rows = await this.posts.find({
      where: { ownerId: userId, expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.present(r, userId));
  }

  /** Everyone's live posts: ?search= (title, company, location) &jobType= &page= &limit= */
  async listPublic(userId: string, q: ListPostedJobsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const qb = this.posts
      .createQueryBuilder('p')
      .leftJoin('p.owner', 'owner')
      .addSelect(['owner.id', 'owner.firstName'])
      .where('p."expiresAt" > :now', { now: new Date() })
      .orderBy('p.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (q.jobType) qb.andWhere('p."jobType" = :jobType', { jobType: q.jobType });
    const term = q.search?.trim();
    if (term) {
      qb.andWhere('(p.title ILIKE :term OR p.company ILIKE :term OR p.location ILIKE :term)', {
        term: `%${escapeLike(term)}%`,
      });
    }
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.present(r, userId)), total, page, limit };
  }

  async getOne(userId: string, id: string) {
    assertValidId(id, 'Job post');
    const post = await this.posts.findOne({ where: { id }, relations: { owner: true } });
    if (!post || post.expiresAt.getTime() <= Date.now()) throw new NotFoundException('Job post not found');
    return this.present(post, userId);
  }

  // ---------------------------------------------------------------- update / delete (owner only)

  async update(userId: string, id: string, dto: UpdatePostedJobDto) {
    const post = await this.ownedLivePost(userId, id);

    const next = {
      applyUrl: dto.applyUrl !== undefined ? dto.applyUrl : post.applyUrl,
      applyEmail: dto.applyEmail !== undefined ? dto.applyEmail : post.applyEmail,
    };
    this.requireContactMethod(next.applyUrl, next.applyEmail);

    if (dto.title !== undefined) post.title = dto.title;
    if (dto.company !== undefined) post.company = dto.company;
    if (dto.location !== undefined) post.location = dto.location;
    if (dto.jobType !== undefined) post.jobType = dto.jobType;
    if (dto.description !== undefined) post.description = dto.description;
    if (dto.salary !== undefined) post.salary = dto.salary;
    if (dto.isRemote !== undefined) post.isRemote = dto.isRemote;
    post.applyUrl = next.applyUrl ?? null;
    post.applyEmail = next.applyEmail ?? null;
    if (dto.expiresAt !== undefined) post.expiresAt = this.parseExpiry(dto.expiresAt);

    const saved = await this.posts.save(post);
    return this.present(saved, userId);
  }

  async remove(userId: string, id: string) {
    const post = await this.ownedLivePost(userId, id);
    await this.posts.delete({ id: post.id, ownerId: userId });
    return { deleted: true };
  }

  // ---------------------------------------------------------------- expiry

  /**
   * Deletes every post whose expiry date has passed and sends each owner a notification. Never throws: it runs on
   * a timer, and one bad run must not stop the next one. Works in batches so a large backlog cannot lock the table.
   */
  async sweepExpired(): Promise<number> {
    let removed = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const now = new Date();
        const expired = await this.posts.find({
          where: { expiresAt: LessThanOrEqual(now) },
          select: { id: true, ownerId: true, title: true },
          take: SWEEP_BATCH,
        });
        if (expired.length === 0) break;

        // Re-check the date in the DELETE itself, so a post whose owner just extended it is never removed.
        const res = await this.posts
          .createQueryBuilder()
          .delete()
          .from(PostedJob)
          .where('id IN (:...ids)', { ids: expired.map((e) => e.id) })
          .andWhere('"expiresAt" <= :now', { now })
          .execute();
        removed += res.affected ?? 0;

        await Promise.all(
          expired.map((e) =>
            this.notifications.notify(e.ownerId, {
              type: 'SYSTEM',
              title: 'Your job post expired',
              body: `"${e.title}" reached its expiry date, so it was removed automatically. You can post it again any time.`,
              link: '/posted-jobs',
            }),
          ),
        );
        if (expired.length < SWEEP_BATCH) break;
      }
      if (removed > 0) this.logger.log(`Removed ${removed} expired job post(s).`);
    } catch (err) {
      this.logger.warn(`Expired job post sweep failed: ${(err as Error).message}`);
    }
    return removed;
  }

  // ---------------------------------------------------------------- helpers

  /** The post, if it is live and belongs to `userId`. Someone else's post is a 403; an expired one is gone (404). */
  private async ownedLivePost(userId: string, id: string): Promise<PostedJob> {
    assertValidId(userId, 'User');
    assertValidId(id, 'Job post');
    const post = await this.posts.findOne({ where: { id } });
    if (!post || post.expiresAt.getTime() <= Date.now()) throw new NotFoundException('Job post not found');
    if (post.ownerId !== userId) throw new ForbiddenException('You can only change your own job posts.');
    return post;
  }

  private requireContactMethod(applyUrl?: string | null, applyEmail?: string | null) {
    if (!applyUrl && !applyEmail) {
      throw new BadRequestException('Add a way to apply: an apply link, an apply email, or both.');
    }
  }

  private parseExpiry(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('That expiry date is not valid.');
    const now = Date.now();
    if (date.getTime() < now + MIN_LEAD_MS) throw new BadRequestException('Pick an expiry date and time in the future.');
    if (date.getTime() > now + MAX_POST_DAYS * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`A job post can stay up for at most ${MAX_POST_DAYS} days.`);
    }
    return date;
  }

  /** What the frontend gets: the post plus `isMine` and the poster's first name. The owner's other details never leave the server. */
  private present(post: PostedJob, viewerId: string) {
    const { owner, ...rest } = post;
    return {
      ...(post.toJSON() as Record<string, any>),
      owner: undefined,
      isMine: rest.ownerId === viewerId,
      postedBy: owner?.firstName?.trim() || 'A member',
    };
  }
}