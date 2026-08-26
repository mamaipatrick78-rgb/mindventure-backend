import fs from 'fs'; import {pool} from './db.js';
await pool.query(fs.readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8')); await pool.end(); console.log('Database ready');
