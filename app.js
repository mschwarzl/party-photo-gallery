const express = require('express');
const basicAuth = require('express-basic-auth');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
const port = 3000;

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Configure AWS S3
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const bucketName = process.env.S3_BUCKET_NAME;

// Set up storage with Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware for basic auth
app.use(basicAuth({
    users: { 'user': process.env.AUTH_PASSWORD },
    challenge: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let cachedObjects = [];
let lastFetchTime = null;
const maxCacheSize = 2 * 1024 * 1024 * 1024; // 2 GB

// Fetch all objects from S3 and sort them by LastModified date
async function fetchAllObjects() {
    let objects = [];
    let isTruncated = true;
    let continuationToken = null;

    while (isTruncated) {
        const params = {
            Bucket: bucketName,
            ContinuationToken: continuationToken,
        };

        const command = new ListObjectsV2Command(params);
        const data = await s3Client.send(command);

        objects = objects.concat(data.Contents);
        isTruncated = data.IsTruncated;
        continuationToken = data.NextContinuationToken;
    }

    // Sort objects by LastModified date descending
    objects.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
    return objects;
}

// Update cache
async function updateCache() {
    cachedObjects = await fetchAllObjects();
    lastFetchTime = Date.now();
    enforceCacheSizeLimit();
}

// Enforce cache size limit
function enforceCacheSizeLimit() {
    let totalSize = cachedObjects.reduce((acc, obj) => acc + obj.Size, 0);

    if (totalSize > maxCacheSize) {
        cachedObjects.sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));

        while (totalSize > maxCacheSize && cachedObjects.length > 0) {
            const removed = cachedObjects.shift();
            totalSize -= removed.Size;
        }
    }
}

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Handle image and video upload
app.post('/upload', upload.array('media', 10), async (req, res) => {
    const files = req.files;
    try {
        const uploadPromises = files.map(async file => {
            const fileExtension = path.extname(file.originalname).toLowerCase();
            const fileName = `${uuidv4()}${fileExtension}`;
            const tempFilePath = path.join(tempDir, fileName);

            // Save file to temp directory
            fs.writeFileSync(tempFilePath, file.buffer);

            // Dynamically import file-type module
            const { fileTypeFromFile } = await import('file-type');

            // Convert HEVC to H.264 if necessary
            let finalFilePath = tempFilePath;
            const detectedType = await fileTypeFromFile(tempFilePath);
            if (detectedType && detectedType.mime === 'video/quicktime') { // This is a .mov file which might be HEVC
                const convertedFileName = `${uuidv4()}_converted.mp4`;
                finalFilePath = path.join(tempDir, convertedFileName);
                await convertToH264(tempFilePath, finalFilePath);
                fs.unlinkSync(tempFilePath); // Delete original HEVC file
            }

            // Upload to S3
            const upload = new Upload({
                client: s3Client,
                params: {
                    Bucket: bucketName,
                    Key: finalFilePath === tempFilePath ? fileName : path.basename(finalFilePath),
                    Body: fs.createReadStream(finalFilePath),
                    ContentType: file.mimetype,
                }
            });
            await upload.done();
            fs.unlinkSync(finalFilePath); // Delete the converted file

            return { Key: finalFilePath === tempFilePath ? fileName : path.basename(finalFilePath) };
        });

        const results = await Promise.all(uploadPromises);
        await updateCache(); // Update the cache after uploading new files
        res.json({ message: 'Files uploaded successfully', results });
    } catch (error) {
        console.error('Error uploading files:', error);
        res.status(500).json({ error: error.message });
    }
});

// Convert HEVC to H.264
function convertToH264(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        exec(`ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -crf 23 "${outputPath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error converting file: ${stderr}`);
                return reject(error);
            }
            resolve();
        });
    });
}

// Fetch media with pagination from cached objects
app.get('/gallery', async (req, res) => {
    const { limit = 10, offset = 0 } = req.query;
    const limitInt = parseInt(limit);
    const offsetInt = parseInt(offset);

    // Refresh cache every 5 minutes
    const cacheDuration = 5 * 60 * 1000; // 5 minutes

    if (!lastFetchTime || (Date.now() - lastFetchTime) > cacheDuration) {
        await updateCache();
    }

    const paginatedObjects = cachedObjects.slice(offsetInt, offsetInt + limitInt);

    try {
        const media = await Promise.all(paginatedObjects.map(async item => {
            const getObjectCommand = new GetObjectCommand({
                Bucket: bucketName,
                Key: item.Key,
            });

            const url = await getSignedUrl(s3Client, getObjectCommand, { expiresIn: 3600 });
            return {
                url,
                type: item.Key.match(/\.(mp4|webm|ogg)$/i) ? 'video' : 'image',
                lastModified: item.LastModified,
                key: item.Key
            };
        }));

        res.json({
            media,
            nextOffset: offsetInt + limitInt < cachedObjects.length ? offsetInt + limitInt : null,
        });
    } catch (error) {
        console.error('Error fetching gallery:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve fonts with correct MIME types
app.get('/fonts/:fontName', async (req, res) => {
    const fontPath = path.join(__dirname, 'public', 'fonts', req.params.fontName);
    const mime = await import('mime'); // Dynamically import the mime module

    res.sendFile(fontPath, err => {
        if (err) {
            console.error('Error serving font:', err);
            res.status(404).end();
        } else {
            res.setHeader('Content-Type', mime.getType(fontPath));
        }
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

