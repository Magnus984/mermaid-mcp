import dotenv from 'dotenv';

dotenv.config();

export interface FileStorageConfig {
  baseUrl?: string;
  timeout: number;
  retries: number;
}

export const fileStorageConfig: FileStorageConfig = {
  baseUrl: process.env.FILE_STORAGE_URL,
  timeout: 30000,
  retries: 3
}; 