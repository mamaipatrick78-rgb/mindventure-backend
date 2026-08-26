import pg from 'pg'; import 'dotenv/config';
const {Pool}=pg; export const pool=new Pool({connectionString:process.env.DATABASE_URL});
export const q=(sql,args=[])=>pool.query(sql,args);
