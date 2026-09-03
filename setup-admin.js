const { upsertAdmin, dbPath } = require('./database');

function readHiddenPassword() {
  if (!process.stdin.isTTY) {
    return new Promise(resolve => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { value += chunk; });
      process.stdin.on('end', () => resolve(value.trim()));
    });
  }
  return new Promise(resolve => {
    let value = '';
    process.stdout.write('Пароль администратора: ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const key of chunk) {
        if (key === '\r' || key === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (key === '\u0003') {
          process.exit(130);
        } else if (key === '\u007f' || key === '\b') {
          value = value.slice(0, -1);
        } else {
          value += key;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  const password = process.env.ALEGIERI_ADMIN_PASSWORD || await readHiddenPassword();
  if (!password || password.length < 8) throw new Error('Пароль должен содержать не менее 8 символов');
  upsertAdmin('admin', password);
  console.log(`Администратор настроен. База: ${dbPath}`);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});

