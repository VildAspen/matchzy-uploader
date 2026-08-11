const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');

const app = express();
app.use(express.raw({ type: '*/*', limit: '500mb' }));

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

app.post('/upload', async (req, res) => {
  try {
    const filename = req.header('MatchZy-FileName') || `demo_${Date.now()}.dem`;
    const matchId = req.header('MatchZy-MatchId') || '1';

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: filename,
      Body: req.body,
      ContentType: 'application/octet-stream',
    }));

    const demoUrl = `${process.env.PUBLIC_URL}/${filename}`;

    if (process.env.DISCORD_WEBHOOK_URL) {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: "🎬 MatchZy Demo Redo!",
          description: `Match-ID: **${matchId}**\nFil: \`${filename}\``,
          color: 0xD4AF37,
          fields: [{ name: "Ladda ner", value: `[Klicka här för att ladda ner](${demoUrl})` }],
          footer: { text: "GubbLir Demos" }
        }]
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Uploader running!'));
