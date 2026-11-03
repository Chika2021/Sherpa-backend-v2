import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

@Entity('resumes')
export class Resume extends SerializableEntity {
  static readonly keepNull = ['parsedProfile'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' }) originalName: string;
  @Column({ type: 'text' }) filePath: string;
  @Column({ type: 'text' }) mimeType: string;
  @Column({ type: 'text' }) rawText: string;

  // Structured extraction: skills, experience, education, etc.
  @Column({ type: 'jsonb', nullable: true, default: null })
  parsedProfile?: Record<string, any> | null;

  @Column({ type: 'boolean', default: false }) isPrimary: boolean;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
