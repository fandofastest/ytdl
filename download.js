const { spawn, exec } = require('child_process');
const path = require('path');

const YTDLP = 'e\\AICODING\\ytdl\\yt-dlp.exe';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node download.js <youtube_url>');
  process.exit(1);
}

const outputDir = path.join(__dirname, 'downloads');
const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

const proc = spawn(YTDLP, [url, '-o', outputTemplate]);

proc.stdout.on('data', (data) => process.stdout.write(data));
proc.stderr.on('data', (data) => process.stderr.write(data));

proc.on('close', (code) => {
  if (code === 0) {
    console.log('\nDownload selesai.');
    exec(`explorer "${outputDir}"`);
  } else {
    console.error('yt-dlp exit code:', code);
  }
});
