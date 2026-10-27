import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('src/delivery/certs');
const destDir = path.resolve('dist/src/delivery/certs');

if (fs.existsSync(srcDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    if (file.endsWith('.pem')) {
      const srcFile = path.join(srcDir, file);
      const destFile = path.join(destDir, file);
      fs.copyFileSync(srcFile, destFile);
    }
  }
}
