import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '../../data'),
  csvDir: path.resolve(__dirname, '../..'), // root dir where CSV files are
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  authSecret: process.env.AUTH_SECRET || 'dev-secret-change-in-production',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  cache: {
    priceTtl: 15 * 60, // 15 minutes in seconds
    historyTtl: 12 * 60 * 60, // 12 hours
  },
};

export const isProduction = config.nodeEnv === 'production';
