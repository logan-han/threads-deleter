// Runs before each test module is evaluated, so config.js sees these values.
process.env.THREADS_APP_ID = 'app-id';
process.env.THREADS_APP_SECRET = 'app-secret';
process.env.STATE_SECRET = 'state-secret';
process.env.TABLE_NAME = 'threads-deleter-test';
