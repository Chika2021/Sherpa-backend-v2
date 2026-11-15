import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { LocalJobBoard, localBoardCountryKey } from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { Actor } from './admin.service';
import { CreateLocalJobBoardDto, ListLocalJobBoardsQueryDto, UpdateLocalJobBoardDto } from './local-job-boards.dto';
import { MAX_LINKS_PER_BOARD, ParsedLinks, linkKey, parseLinkBlock } from './local-job-links';

/** What a paste did to a board - shown to the admin right after saving. */
export interface LinkChangeSummary {
  added: number;
  removed: number;
  /** Links on the board now. */
  total: number;
  /** Repeats inside the pasted text that were ignored. */
  duplicatesIgnored: number;
  /** Pasted entries that were not usable links (first 50 shown). */
  invalidCount: number;
  invalid: string[];
}

const isUniqueViolation = (err: unknown) => err instanceof QueryFailedError && (err as any).driverError?.code === '23505';

/**
 * Create / read / update / delete for local job boards (one board per country).
 * Who may call it is decided in LocalJobBoardsController (ADMIN and SUPER_ADMIN).
 */
@Injectable()
export class LocalJobBoardsService {
  constructor(@InjectRepository(LocalJobBoard) private boards: Repository<LocalJobBoard>) {}

  /** Boards without their links (use get() for those) - a page of them, A-Z by country. */
  async list(q: ListLocalJobBoardsQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const search = q.search?.trim();

    const qb = this.boards
      .createQueryBuilder('b')
      .select(['b.id', 'b.country', 'b.linkCount', 'b.createdAt', 'b.updatedAt', 'b.updatedById']);
    if (search) qb.where('b.country ILIKE :like', { like: `%${escapeLike(search)}%` });
    qb.orderBy('b.country', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
  }

  async get(id: string) {
    return this.present(await this.requireBoard(id));
  }

  /** New board for a country from a pasted block of links. A country can only have one board. */
  async create(actor: Actor, dto: CreateLocalJobBoardDto) {
    const country = this.cleanCountry(dto.country);
    const parsed = parseLinkBlock(dto.links);
    this.assertUsable(parsed);

    const key = localBoardCountryKey(country);
    const existing = await this.findByKey(key);
    if (existing) throw this.alreadyExists(existing);

    let saved: LocalJobBoard;
    try {
      saved = await this.boards.save(
        this.boards.create({
          country,
          countryKey: key,
          links: parsed.links,
          linkCount: parsed.links.length,
          createdById: actor.id,
          updatedById: actor.id,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`A local job board for ${country} already exists. Update it instead.`);
      throw err;
    }
    return { board: this.present(saved), summary: this.summary(parsed, { added: parsed.links.length, removed: 0, total: parsed.links.length }) };
  }

  /**
   * Update a board: rename its country and/or change its links from a paste (see UpdateLocalJobBoardDto.mode;
   * the default replaces the links with exactly what was pasted).
   */
  async update(actor: Actor, id: string, dto: UpdateLocalJobBoardDto) {
    assertValidId(id, 'Local job board');
    if (dto.country === undefined && dto.links === undefined) {
      throw new BadRequestException('Nothing to update: send a country and/or links.');
    }
    const board = await this.requireBoard(id);
    const patch: Partial<LocalJobBoard> = {};
    let summary: LinkChangeSummary = {
      added: 0,
      removed: 0,
      total: board.links.length,
      duplicatesIgnored: 0,
      invalidCount: 0,
      invalid: [],
    };

    if (dto.country !== undefined) {
      const country = this.cleanCountry(dto.country);
      if (country !== board.country) {
        const key = localBoardCountryKey(country);
        if (key !== localBoardCountryKey(board.country)) {
          const clash = await this.findByKey(key);
          if (clash && clash.id !== board.id) throw this.alreadyExists(clash);
          patch.countryKey = key;
        }
        patch.country = country;
      }
    }

    if (dto.links !== undefined) {
      const parsed = parseLinkBlock(dto.links);
      const mode = dto.mode ?? 'replace';
      const current = board.links;
      const currentKeys = new Set(current.map(linkKey));
      let next: string[];

      if (mode === 'remove') {
        const drop = new Set(parsed.links.map(linkKey));
        next = current.filter((l) => !drop.has(linkKey(l)));
        if (next.length === current.length) this.assertUsable(parsed); // nothing matched: say why if the paste had no links at all
        if (next.length === 0) {
          throw new BadRequestException('That would remove every link from this board. Delete the board instead.');
        }
      } else {
        this.assertUsable(parsed);
        if (mode === 'append') {
          next = [...current, ...parsed.links.filter((l) => !currentKeys.has(linkKey(l)))];
        } else {
          next = parsed.links;
        }
      }
      if (next.length > MAX_LINKS_PER_BOARD) {
        throw new BadRequestException(`A board can hold at most ${MAX_LINKS_PER_BOARD} links (this would be ${next.length}).`);
      }

      const nextKeys = new Set(next.map(linkKey));
      const added = next.filter((l) => !currentKeys.has(linkKey(l))).length;
      const removed = current.filter((l) => !nextKeys.has(linkKey(l))).length;
      summary = this.summary(parsed, { added, removed, total: next.length });
      if (added > 0 || removed > 0 || next.some((l, i) => l !== current[i])) {
        patch.links = next;
        patch.linkCount = next.length;
      }
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedById = actor.id;
      try {
        await this.boards.update({ id }, patch as any);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException('Another local job board already uses that country.');
        throw err;
      }
    }
    return { board: this.present(await this.requireBoard(id)), summary };
  }

  async remove(id: string) {
    assertValidId(id, 'Local job board');
    const res = await this.boards.delete({ id });
    if (!res.affected) throw new NotFoundException('Local job board not found');
    return { deleted: true, id };
  }

  // ---- helpers ----

  private async requireBoard(id: string): Promise<LocalJobBoard> {
    assertValidId(id, 'Local job board');
    const board = await this.boards.findOneBy({ id });
    if (!board) throw new NotFoundException('Local job board not found');
    return board;
  }

  private findByKey(countryKey: string) {
    return this.boards.findOne({ where: { countryKey }, select: { id: true, country: true } });
  }

  private alreadyExists(existing: Pick<LocalJobBoard, 'id' | 'country'>) {
    return new ConflictException(`A local job board for ${existing.country} already exists (id ${existing.id}). Update that one instead.`);
  }

  /** Trim and collapse spaces; letters, spaces and . ' ’ - ( ) & , only (covers "Côte d'Ivoire", "Congo (DRC)"). */
  private cleanCountry(raw: string): string {
    const country = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (country.length < 2 || country.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’()&,-]*$/u.test(country)) {
      throw new BadRequestException('Enter a country name (letters only, 2 to 80 characters).');
    }
    return country;
  }

  private assertUsable(parsed: ParsedLinks) {
    if (parsed.links.length === 0) {
      const hint = parsed.invalidCount ? ` ${parsed.invalidCount} entr${parsed.invalidCount === 1 ? 'y was' : 'ies were'} skipped, e.g. ${parsed.invalid.slice(0, 3).join(', ')}.` : '';
      throw new BadRequestException(`No valid job links found in what was pasted.${hint}`);
    }
    if (parsed.links.length > MAX_LINKS_PER_BOARD) {
      throw new BadRequestException(`A board can hold at most ${MAX_LINKS_PER_BOARD} links (${parsed.links.length} were pasted).`);
    }
  }

  private summary(parsed: ParsedLinks, change: { added: number; removed: number; total: number }): LinkChangeSummary {
    return {
      ...change,
      duplicatesIgnored: parsed.duplicates,
      invalidCount: parsed.invalidCount,
      invalid: parsed.invalid,
    };
  }

  private present(board: LocalJobBoard): LocalJobBoard {
    board.countryKey = undefined; // internal key, never sent to the dashboard
    return board;
  }
}
