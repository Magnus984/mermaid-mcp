import dotenv from 'dotenv';

dotenv.config();

export interface FileStorageConfig {
  baseUrl?: string;
  apiKey?: string;
  timeout: number;
  retries: number;
}

export const fileStorageConfig: FileStorageConfig = {
  baseUrl: process.env.FILE_STORAGE_URL,
  apiKey: process.env.FILE_STORAGE_API_KEY,
  timeout: 30000,
  retries: 3
}; 