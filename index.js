const fs = require("fs");
const rimraf = require("rimraf");
const { ffmpeg, info, encodeRenditions } = require("./lib/ffmpeg");
const input =
  "/Users/ash/Downloads/REVIEW-%20Amsterdam%20Light%20Festival%20-%2019%20artworks.mp4";
const output = "/Users/ash/Web/video/output/";
const renditions = require("./renditions.json");

rimraf.sync(output);
fs.mkdirSync(output);

const start = new Date();
const action = encodeRenditions({ input, renditions: renditions, output });
action.on("progress", progress =>
  console.log(
    String(progress.percent) + "%",
    Math.round(progress.eta / 60),
    "minutes remaining"
  )
);

action.on("log", console.log);
action.on("close", () => {
  console.log("started at ", start);
  console.log("finished at", new Date());
});
