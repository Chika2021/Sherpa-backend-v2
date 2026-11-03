import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { ResumeProfile } from '../ai/gemini.service';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { Resume } from './resume.entity';

/**
 * A resume built (or polished) by the AI resume maker, as opposed to
 * `Resume`, which is a raw file the user uploaded. Each one stores the
 * structured profile content plus the path to its rendered PDF on disk.
 */
@Entity('generated_resumes')
export class GeneratedResume extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // The uploaded resume this was built from, if the user based it on one.
  @Column({ type: 'uuid', nullable: true })
  sourceResumeId?: string;

  @ManyToOne(() => Resume, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'sourceResumeId' })
  sourceResume?: Resume;

  // Role this version was tailored toward, if any, e.g. "Senior Frontend Engineer".
  @Column({ type: 'text', nullable: true })
  targetRole?: string;

  @Column({ type: 'text' })
  title: string;

  // The AI-generated, structured resume content (see ResumeProfile).
  @Column({ type: 'jsonb' })
  profile: ResumeProfile;

  // Filesystem path to the rendered PDF, written by ResumePdfService.
  @Column({ type: 'text', nullable: true })
  pdfPath?: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
