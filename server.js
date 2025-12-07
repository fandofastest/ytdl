const http = require('http');
const urlModule = require('url');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const YTDLP = process.env.YTDLP_PATH || (process.platform === 'win32'
  ? 'e:\\AICODING\\ytdl\\yt-dlp.exe'
  : 'yt-dlp');

const FFMPEG = process.env.FFMPEG_PATH || (process.platform === 'win32'
  ? 'e:\\AICODING\\ytdl\\ffmpeg\\bin\\ffmpeg.exe'
  : 'ffmpeg');
const baseDownloadsDir = path.join(__dirname, 'downloads');
const videoDir = path.join(baseDownloadsDir, 'video');
const audioDir = path.join(baseDownloadsDir, 'audio');

function getDiskUsage() {
  try {
    const { execSync } = require('child_process');

    if (process.platform === 'win32') {
      const driveRoot = path.parse(baseDownloadsDir).root;
      const deviceId = driveRoot.replace(/\\+/g, '').slice(0, 2);

      const output = execSync(`wmic logicaldisk where "DeviceID='${deviceId}'" get FreeSpace,Size /format:csv`, {
        encoding: 'utf8',
      });

      const lines = output.split(/\r?\n/).filter((l) => l.trim());
      const dataLine = lines[lines.length - 1];
      const parts = dataLine.split(',');
      const free = parseInt(parts[1], 10);
      const size = parseInt(parts[2], 10);

      if (!Number.isFinite(free) || !Number.isFinite(size) || size <= 0) {
        return null;
      }

      return { free, size, freeRatio: free / size };
    }

    const output = execSync(`df -k "${baseDownloadsDir}"`, { encoding: 'utf8' });
    const lines = output.split(/\r?\n/).filter((l) => l.trim());
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.split(/\s+/);
    const sizeKb = parseInt(parts[1], 10);
    const freeKb = parseInt(parts[3], 10);

    if (!Number.isFinite(sizeKb) || !Number.isFinite(freeKb) || sizeKb <= 0) {
      return null;
    }

    const size = sizeKb * 1024;
    const free = freeKb * 1024;
    return { free, size, freeRatio: free / size };
  } catch (e) {
    return null;
  }
}

function listDownloadFiles() {
  const result = [];
  const dirs = [audioDir, videoDir];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          result.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch (e) {
      }
    }
  }

  return result;
}

function cleanupDownloadsIfLowSpace() {
  const usage = getDiskUsage();
  if (!usage) {
    return;
  }

  if (usage.freeRatio >= 0.2) {
    return;
  }

  let files = listDownloadFiles();
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  while (files.length > 0) {
    const currentUsage = getDiskUsage();
    if (!currentUsage || currentUsage.freeRatio >= 0.5) {
      break;
    }

    const file = files.shift();
    try {
      fs.unlinkSync(file.path);
    } catch (e) {
    }
  }
}

function extractFilePath(stdout) {
  const lines = stdout.split(/\r?\n/);

  let lastPath = null;

  for (const line of lines) {
    const destMatch = line.match(/Destination:\s*(.+)$/);
    if (destMatch) {
      lastPath = destMatch[1].trim();
      continue;
    }

    const downloadedMatch = line.match(/\] (.+) has already been downloaded/);
    if (downloadedMatch) {
      lastPath = downloadedMatch[1].trim();
      continue;
    }
  }

  return lastPath;
}

function downloadVideo(videoUrl, format, callback) {
  const isAudio = format === 'mp3';
  const targetDir = isAudio ? audioDir : videoDir;

  fs.mkdirSync(targetDir, { recursive: true });

  const outputTemplate = path.join(targetDir, '%(id)s.%(ext)s');

  const ffmpegArgs = [];
  if (process.env.FFMPEG_PATH || process.platform === 'win32') {
    ffmpegArgs.push('--ffmpeg-location', FFMPEG);
  }

  const args = [
    videoUrl,
    '-o', outputTemplate,
    '--cookies-from-browser', 'brave',
    ...ffmpegArgs,
  ];

  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', 'mp4');
  }

  const proc = spawn(YTDLP, args);

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    process.stdout.write(text);
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    process.stderr.write(text);
  });

  proc.on('close', (code) => {
    const filePath = extractFilePath(stdout) || null;
    callback(code, stdout, stderr, filePath, targetDir);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = urlModule.parse(req.url, true);

  if (parsedUrl.pathname === '/download' && req.method === 'GET') {
    cleanupDownloadsIfLowSpace();
    const videoUrl = parsedUrl.query.url;
    const formatParam = (parsedUrl.query.format || 'mp4').toLowerCase();
    const dlParam = parsedUrl.query.dl;
    const wantDownload = dlParam && dlParam !== '0' && dlParam !== 'false';
    const playParam = parsedUrl.query.play;
    const wantInline = playParam && playParam !== '0' && playParam !== 'false';
    const isAudioRequest = formatParam === 'mp3';

    if (!['mp3', 'mp4'].includes(formatParam)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'format harus mp3 atau mp4' }));
      return;
    }

    if (!videoUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'query param "url" wajib diisi' }));
      return;
    }
    downloadVideo(videoUrl, formatParam, (code, stdout, stderr, filePath, targetDir) => {
      if (code === 0) {
        if ((wantDownload || wantInline) && filePath) {
          try {
            const stat = fs.statSync(filePath);
            const filename = path.basename(filePath);
            const contentType = isAudioRequest ? 'audio/mpeg' : 'video/mp4';

            const headers = {
              'Content-Type': contentType,
              'Content-Length': stat.size,
            };

            if (wantDownload) {
              headers['Content-Disposition'] = `attachment; filename="${filename}"`;
            }

            res.writeHead(200, headers);

            const stream = fs.createReadStream(filePath);
            stream.on('error', () => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'gagal membaca file hasil download' }));
            });
            stream.pipe(res);
            return;
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'file hasil download tidak ditemukan' }));
            return;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Download selesai',
          format: formatParam,
          outputDir: targetDir,
          filePath,
          stdout,
          stderr,
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: 'Download gagal',
          exitCode: code,
          stdout,
          stderr,
        }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server download jalan di http://localhost:${PORT}`);
});
