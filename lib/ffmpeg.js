const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const { kebabCase } = require("lodash");
const EventEmitter = require("events");
const makeEta = require("simple-eta");
const children = [];

function safeSpawn(...args) {
  const probe = spawn(...args);
  children.push(probe);
  return probe;
}

process.on("SIGINT", function() {
  console.log("killing", children.length, "child processes");
  children.forEach(child => child.kill());
});

class Action extends EventEmitter {
  constructor({ input, probe }) {
    super();
    this.filename = input;
    this.probe = probe;
    this.info = null;
    this.progress = null;
    this.eta = makeEta({ min: 0, max: 100 });
    this.eta.start();

    info(input)
      .then(info => (this.info = info))
      .catch(e => console.error(e));

    probe.stderr.on("data", data => {
      // parse data string
      const dataString = data.toString("utf-8");
      const progressData = dataString.match(/(\w+)=(\s*?\w+)/g);

      // if it's not a parseable string, just emit it as a log
      if (!progressData) {
        this.emit("log", dataString);
        return;
      }
      if (!this.info) return;

      // Parse out the props in our string
      const props = {};
      progressData.forEach(prop => {
        const [key, value] = prop.split("=").map(val => val.trim());
        props[key] = value;
      });

      // Get the frame count from our original video
      const videoStream = this.info.streams.find(
        stream => stream.codec_type === "video"
      );
      if (!videoStream) return;
      const frameCount = videoStream.nb_frames;

      // calculate & emit progress
      const percent =
        Math.round(((props.frame || 0) / (frameCount || 1)) * 10000) / 100;
      this.eta.report(percent);
      props.frameCount = frameCount;
      props.percent = percent;

      this.progress = props;
      this.emit("progress", {
        percent,
        eta: this.eta.estimate()
      });
    });

    probe.on("close", code => {
      if (code) console.error("Exiting with code", code);
      this.emit("close", code);
    });
  }
}

function argArray(args) {
  const flatArgs = [];
  Object.entries(args).forEach(([key, value]) => flatArgs.push(key, value));
  return flatArgs.filter(arg => typeof arg !== "undefined");
}

function ffmpeg(args) {
  return safeSpawn("ffmpeg", args);
}

function info(file) {
  return new Promise((resolve, reject) => {
    const probe = safeSpawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file
    ]);
    let fullData = "",
      fullError = "";
    probe.stdout.on("data", data => {
      fullData += data;
    });

    probe.stderr.on("data", data => {
      fullError += data;
    });

    probe.on("close", code => {
      if (code) return reject(fullError);
      try {
        const parsed = JSON.parse(fullData);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function time(file, probe, onChange) {}

function encodeRenditions({ input, renditions, output, onChange }) {
  const outputDirs = [];
  const args = [];
  const renditionProps = renditions.map(
    ({
      quality,
      resolution,
      bitrateLowMotion,
      bitrateHighMotion,
      bitrateAudio
    }) => {
      const segmentDir = path.join(output, kebabCase(quality));
      outputDirs.push(segmentDir);

      args.push(
        ...argArray({
          "-vf": `scale=w=${resolution[0]}:h=${
            resolution[1]
          }:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
          "-c:a": "aac",
          "-ar": 48000,
          "-c:v": "h264",
          "-profile:v": "main",
          "-crf": 20,
          "-sc_threshold": 0,
          "-g": 48,
          "-keyint_min": 48,
          "-hls_time": 4,
          "-hls_playlist_type": "vod",
          "-b:v": bitrateLowMotion,
          "-maxrate": bitrateHighMotion,
          "-bufsize": "1200k",
          "-b:a": bitrateAudio,
          "-hls_segment_filename": path.join(segmentDir, "%03d.ts"),
          [path.join(segmentDir, "index.m3u8")]: undefined
        })
      );
      return {
        name: kebabCase(quality),
        bandwidth: bitrateHighMotion.replace("k", "000"),
        resolution
      };
    }
  );

  outputDirs.forEach(dir => fs.mkdirSync(dir));
  const command = ["-hide_banner", "-y", "-i", input, ...args];

  console.log(command.join(" "));
  const probe = ffmpeg(command);

  // Generate index m3u8
  const indexTemplate = `#EXTM3U
#EXT-X-VERSION:3
${renditionProps
    .map(
      ({
        name,
        bandwidth,
        resolution
      }) => `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution.join(
        "x"
      )}
${name}/index.m3u8`
    )
    .join("\n")}`;
  fs.writeFileSync(path.join(output, "index.m3u8"), indexTemplate);
  return new Action({ input, probe });
}

module.exports = {
  ffmpeg,
  info,
  encodeRenditions
};
