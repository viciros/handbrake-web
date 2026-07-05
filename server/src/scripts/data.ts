import path from 'path';
import { cwd } from 'process';

export const getDataPath = () => process.env.DATA_PATH || path.join(cwd(), '../data');
