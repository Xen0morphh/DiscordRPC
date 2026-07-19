const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'proper-lockfile') {
    return {
      lock: async () => {
        return async () => {};
      },
      unlock: async () => {}
    };
  }
  return originalRequire.apply(this, arguments);
};

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);


const maxAttempts = 30;
const delayMs = 500;

function wrapPromise(obj, name) {
  const original = obj[name];
  if (!original) return;
  obj[name] = async function (...args) {
    let attempts = 0;
    while (true) {
      try {
        return await original.apply(this, args);
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempts < maxAttempts) {
          attempts++;
          console.warn(`[Build Shield] fs.promises.${name} failed with ${err.code}. Retrying in ${delayMs}ms... (Attempt ${attempts}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  };
}

function wrapCallback(obj, name) {
  const original = obj[name];
  if (!original) return;
  obj[name] = function (...args) {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') {
      return original.apply(this, args);
    }
    const argsWithoutCallback = args.slice(0, -1);
    let attempts = 0;
    
    function attempt() {
      original.apply(obj, [...argsWithoutCallback, (err, ...results) => {
        if (err && (err.code === 'EPERM' || err.code === 'EBUSY') && attempts < maxAttempts) {
          attempts++;
          console.warn(`[Build Shield] fs.${name} failed with ${err.code}. Retrying in ${delayMs}ms... (Attempt ${attempts}/${maxAttempts})`);
          setTimeout(attempt, delayMs);
        } else {
          callback(err, ...results);
        }
      }]);
    }
    attempt();
  };
}

// Wrap promise-based fs operations
wrapPromise(fs.promises, 'rename');
wrapPromise(fs.promises, 'rm');
wrapPromise(fs.promises, 'rmdir');
wrapPromise(fs.promises, 'unlink');

// Wrap callback-based fs operations
wrapCallback(fs, 'rename');
wrapCallback(fs, 'rm');
wrapCallback(fs, 'rmdir');
wrapCallback(fs, 'unlink');

const { build, Platform } = require('electron-builder');

async function main() {
  try {
    console.log('Starting Electron build with EPERM shield...');
    await build({
      targets: Platform.WINDOWS.createTarget(),
    });
    console.log('Build completed successfully!');

    // Automatically package the installer .exe into a .zip file
    const releaseDir = path.join(__dirname, '../release');
    if (fs.existsSync(releaseDir)) {
      const files = fs.readdirSync(releaseDir);
      const installerFile = files.find(f => f.endsWith('.exe') && f.includes('Setup'));
      
      if (installerFile) {
        const installerPath = path.join(releaseDir, installerFile);
        const zipName = `${path.basename(installerFile, '.exe')}.zip`;
        const zipPath = path.join(releaseDir, zipName);
        
        console.log(`[ZIP Packager] Found installer: ${installerFile}. Creating ZIP archive...`);
        
        if (process.platform === 'win32') {
          // Windows PowerShell
          const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${installerPath}' -DestinationPath '${zipPath}' -Force"`;
          await execPromise(cmd);
        } else {
          // Linux/macOS zip command
          const cmd = `zip -j "${zipPath}" "${installerPath}"`;
          await execPromise(cmd);
        }
        console.log(`[ZIP Packager] ZIP created successfully at: ${zipPath}`);
      } else {
        console.warn('[ZIP Packager] No installer file found to ZIP.');
      }
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

main();
