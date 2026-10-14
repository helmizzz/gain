import { dbQuery } from '../src/server/database';

async function main() {
  try {
    const res = await dbQuery("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 20");
    console.log("Audit Events:", res.rows);
  } catch (err) {
    console.error(err);
  }
}
main();
