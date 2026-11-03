import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { Application } from './application.entity';
import { DocumentType } from './enums';

@Entity('generated_documents')
export class GeneratedDocument extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  applicationId?: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'applicationId' })
  application?: Application;

  @Column({ type: 'text' })
  type: DocumentType;

  @Column({ type: 'text' }) content: string;
  @Column({ type: 'text' }) filePath: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
