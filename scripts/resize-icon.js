const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  try {
    const srcPath = path.join(__dirname, '../assets/icon.png');
    const destPath = path.join(__dirname, '../assets/icon.png'); // overwrite original or save as temp
    
    console.log('Loading image from:', srcPath);
    const img = nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) {
      throw new Error('Image is empty or failed to load');
    }
    
    console.log('Resizing to 256x256...');
    const resized = img.resize({ width: 256, height: 256, quality: 'best' });
    
    fs.writeFileSync(srcPath, resized.toPNG());
    console.log('Successfully resized icon to 256x256 PNG');
  } catch (err) {
    console.error('Failed to resize icon:', err);
  } finally {
    app.quit();
  }
});
