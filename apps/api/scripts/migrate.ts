/** Development entry point; the implementation lives in src/db/migrate.ts so it ships in the API image. */
import { migrate } from '../src/db/migrate';

export { migrate };

if (require.main === module) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date'))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
