import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  dataDir: path.resolve(__dirname, '../../data'),
  csvDir: path.resolve(__dirname, '../..'), // root dir where CSV files are
  cache: {
    priceTtl: 15 * 60, // 15 minutes in seconds
    historyTtl: 12 * 60 * 60, // 12 hours
  },
};
