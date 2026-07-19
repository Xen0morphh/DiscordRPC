const fs = require('fs');

const pngPath = 'd:\\project\\DiscordRPC\\assets\\icon.png';
const icoPath = 'd:\\project\\DiscordRPC\\assets\\icon.ico';

try {
  const pngData = fs.readFileSync(pngPath);
  const pngSize = pngData.length;

  const header = Buffer.alloc(22);
  // Header
  header.writeUInt16LE(0, 0);     // Reserved
  header.writeUInt16LE(1, 2);     // Type: ICO (1)
  header.writeUInt16LE(1, 4);     // Count: 1 image

  // Directory Entry
  header.writeUInt8(0, 6);        // Width: 256 (0)
  header.writeUInt8(0, 7);        // Height: 256 (0)
  header.writeUInt8(0, 8);        // Color palette: 0
  header.writeUInt8(0, 9);        // Reserved
  header.writeUInt16LE(1, 10);    // Color planes: 1
  header.writeUInt16LE(32, 12);   // Bits per pixel: 32
  header.writeUInt32LE(pngSize, 14); // Image size (PNG data size)
  header.writeUInt32LE(22, 18);    // Image offset: 22

  const icoData = Buffer.concat([header, pngData]);
  fs.writeFileSync(icoPath, icoData);
  console.log('Successfully created ico file at', icoPath);
} catch (err) {
  console.error('Failed to convert PNG to ICO:', err);
}
