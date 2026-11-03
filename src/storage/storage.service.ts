import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  constructor(private config: ConfigService) {}

  get uploadDir() {
    const dir = this.config.get<string>('UPLOAD_DIR') || './uploads';
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  get generatedDir() {
    const dir = this.config.get<string>('GENERATED_DIR') || './generated';
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeGeneratedFile(userId: string, filename: string, content: string | Buffer) {
    const userDir = path.join(this.generatedDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const fullPath = path.join(userDir, filename);
    fs.writeFileSync(fullPath, content);
    return fullPath;
  }

  publicUrlFor(fullPath: string) {
    const relative = path.relative(this.generatedDir, fullPath).split(path.sep).join('/');
    return `/files/${relative}`;
  }
}
