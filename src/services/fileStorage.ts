import { fileStorageConfig } from '../config/fileStorage.js';
import { Logger } from '../utils/logger.js';

export interface FileResponse {
  fileId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
}

export class FileStorageService {
  private config: typeof fileStorageConfig;

  constructor(config = fileStorageConfig) {
    this.config = config;
  }

  async storeFile(
    buffer: Buffer, 
    filename: string, 
    mimeType: string
  ): Promise<FileResponse> {
    try {
      // Create FormData to match the Python files parameter
      const formData = new FormData();
      
      // Convert Buffer to Uint8Array for compatibility with Blob
      const uint8Array = new Uint8Array(buffer);

      // Add the file (equivalent to Python's files=[("file", (filename, data, mime_type))])
      formData.append('file', new Blob([uint8Array], { type: mimeType }), filename);
      
      // Add metadata (equivalent to Python's data=metadata)
      formData.append('storage_location', 'Azure');
      formData.append('require_auth', 'false');
      
      const response = await fetch(`${this.config.baseUrl}/api/v1/files`, { // Match Python endpoint
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          // Don't set Content-Type - FormData sets it automatically
        },
        body: formData,
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error(`File with name ${filename} already exists`);
        }
        throw new Error(`File storage failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      Logger.info(`File stored successfully: ${result.id}`);
      
      // Return format matching Python response
      return {
        fileId: result.id,
        url: result.download_link,
        filename: filename,
        size: buffer.length,
        mimeType: mimeType
      };
    } catch (error) {
      Logger.error('File storage failed', error);
      throw new Error(`Failed to store file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

//   async deleteFile(fileId: string): Promise<void> {
//     try {
//       const response = await fetch(`${this.config.baseUrl}/files/${fileId}`, {
//         method: 'DELETE',
//         headers: {
//           'Authorization': `Bearer ${this.config.apiKey}`,
//         },
//         signal: AbortSignal.timeout(this.config.timeout),
//       });

//       if (!response.ok) {
//         throw new Error(`File deletion failed: ${response.statusText}`);
//       }

//       Logger.info(`File deleted successfully: ${fileId}`);
//     } catch (error) {
//       Logger.error('File deletion failed', error);
//       throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`);
//     }
//   }
}