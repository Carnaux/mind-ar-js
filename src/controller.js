const Worker = require("./controller.worker.js");
const {Tracker} = require('./image-target/trackingGPU/tracker.js');
const {Detector} = require('./image-target/detectorGPU/detector.js');
const {Matcher} = require('./image-target/matching/matcher.js');
const {estimateHomography} = require('./image-target/icp/estimate_homography.js');
const {refineHomography} = require('./image-target/icp/refine_homography');
const {Compiler} = require('./compiler.js');

const INTERPOLATION_FACTOR = 10;
const MISS_COUNT_TOLERANCE = 10;

class Controller {
  constructor(inputWidth, inputHeight, onUpdate) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    this.detector = new Detector(this.inputWidth, this.inputHeight);
    this.imageTargets = [];
    this.trackingIndex = -1;
    this.trackingMatrix = null;
    this.trackingMissCount = 0;
    this.onUpdate = onUpdate;

    this.processHandler = null;
    this.workerHandler = null;

    this.maxTrack = 1; // technically can tracking multiple. but too slow in practice
    this.imageTargetStates = [];

    const near = 10;
    const far = 10000;
    const fovy = 45.0 * Math.PI / 180; // 45 in radian. field of view vertical
    const f = (this.inputHeight/2) / Math.tan(fovy/2);
    //     [fx  s cx]
    // K = [ 0 fx cy]
    //     [ 0  0  1]
    this.projectionTransform = [
      [f, 0, this.inputWidth / 2],
      [0, f, this.inputHeight / 2],
      [0, 0, 1]
    ];

    this.projectionMatrix = _glProjectionMatrix({
      projectionTransform: this.projectionTransform,
      width: this.inputWidth,
      height: this.inputHeight,
      near: near,
      far: far,
    });

    this.worker = new Worker();

    this.workerMatchDone = null;
    this.workerTrackDone = null;
    this.worker.onmessage = (e) => {
      if (e.data.type === 'matchDone' && this.workerMatchDone !== null) {
        this.workerMatchDone(e.data);
      }
      if (e.data.type === 'trackDone' && this.workerTrackDone !== null) {
        this.workerTrackDone(e.data);
      }
    }
  }

  getProjectionMatrix() {
    return this.projectionMatrix;
  }

  addImageTargets(fileURL) {
    return new Promise(async (resolve, reject) => {
      const compiler = new Compiler();
      const content = await fetch(fileURL);
      const buffer = await content.arrayBuffer();
      const dataList = compiler.importData(buffer);

      const trackingDataList = [];
      const matchingDataList = [];
      const imageListList = [];
      const dimensions = [];
      for (let i = 0; i < dataList.length; i++) {
        matchingDataList.push(dataList[i].matchingData);
        trackingDataList.push(dataList[i].trackingData);
        imageListList.push(dataList[i].imageList);
        dimensions.push([dataList[i].targetImage.width, dataList[i].targetImage.height]);

        this.imageTargetStates[i] = {isTracking: false};
      }
      this.tracker = new Tracker(trackingDataList, imageListList, this.projectionTransform, this.inputWidth, this.inputHeight);

      this.worker.postMessage({
        type: 'setup',
        inputWidth: this.inputWidth,
        inputHeight: this.inputHeight,
        projectionTransform: this.projectionTransform,
        matchingDataList,
      });

      resolve({dimensions: dimensions});
    });
  }

  // warm up gpu - build kernels is slow
  dummyRun(input) {
    this.detector.detect(input);
    this.tracker.track(input, [[0,0,0,0], [0,0,0,0], [0,0,0,0]], 0);
  }

  stopProcessVideo() {
    clearInterval(this.processHandler);
    clearInterval(this.workerHandler);
  }

  /**
   * continue process the video
   * There currently two separate threads:
   *
   * 1. main thread
   *   this thread mainly call the gpu and do the first part of the computation
   * 2. worker thread
   *   this thread run in CPU and use the computation from the first part
   *
   * Other than two separate threads, there are also two, somehow, indepedent jobs
   *
   * 1. detection and match (slow)
   *   This extract FREAK features and try to find a match among the targets
   * 2. track (fast)
   *   Once a target is initialized matched, we can try to keep track of it
   *
   */
  processVideo(input) {
    let featurePoints = null;
    let trackingFeatures = [];
    for (let i = 0; i < this.imageTargetStates.length; i++) {
      trackingFeatures[i] = null;
    }

    let processing = false;
    this.processHandler = setInterval(() => {
      if (!processing) {
        processing = true;

        let trackingCount = 0;
        for (let i = 0; i < this.imageTargetStates.length; i++) {
          if (this.imageTargetStates[i].isTracking) {
            trackingFeatures[i] = this.tracker.track(input, this.imageTargetStates[i].lastModelViewTransform, i);
            trackingCount += 1;
          }
        }
        if (trackingCount < this.maxTrack) { // only run detector when matching is required
          featurePoints = this.detector.detect(input);
        }

        this.onUpdate({type: 'processDone'});
        processing = false;
      }
    }, 10);

    let workerRunning = false;
    this.workerHandler = setInterval(async () => {
      if (!workerRunning) {
        workerRunning = true;

        let trackingCount = 0;
        for (let i = 0; i < this.imageTargetStates.length; i++) {
          if (this.imageTargetStates[i].isTracking) {
            trackingCount += 1;
          }
        }

        if (trackingCount < this.maxTrack && featurePoints !== null) {
          const skipTargetIndexes = [];
          for (let i = 0; i < this.imageTargetStates.length; i++) {
            if (this.imageTargetStates[i].isTracking) {
              skipTargetIndexes.push(i);
            }
          }

          const {targetIndex, modelViewTransform} = await this.workerMatch(featurePoints, skipTargetIndexes);
          if (targetIndex !== -1) {
            this.imageTargetStates[targetIndex].isTracking = true;
            this.imageTargetStates[targetIndex].missCount = 0;
            this.imageTargetStates[targetIndex].lastModelViewTransform = modelViewTransform;
            this.imageTargetStates[targetIndex].trackingMatrix = null;
          }
        }

        for (let i = 0; i < this.imageTargetStates.length; i++) {
          if (this.imageTargetStates[i].isTracking && trackingFeatures[i] !== null) {
            let modelViewTransform = null;
            if (trackingFeatures[i].length >= 4) {
              modelViewTransform = await this.workerTrack(this.imageTargetStates[i].lastModelViewTransform, trackingFeatures[i]);
            }

            if (modelViewTransform === null) {
              this.imageTargetStates[i].missCount += 1;
              if (this.imageTargetStates[i].missCount > MISS_COUNT_TOLERANCE) {
                this.imageTargetStates[i].isTracking = false;
                trackingFeatures[i] = null;
                this.onUpdate({type: 'updateMatrix', targetIndex: i, worldMatrix: null});
              }
            } else {
              this.imageTargetStates[i].lastModelViewTransform = modelViewTransform;

              const worldMatrix = _glModelViewMatrix(modelViewTransform);

              if (this.imageTargetStates[i].trackingMatrix === null) {
                this.imageTargetStates[i].trackingMatrix = worldMatrix;
              } else {
                for (let j = 0; j < worldMatrix.length; j++) {
                  this.imageTargetStates[i].trackingMatrix[j] = this.imageTargetStates[i].trackingMatrix[j] + (worldMatrix[j] - this.imageTargetStates[i].trackingMatrix[j]) / INTERPOLATION_FACTOR;
                }
              }

              const clone = [];
              for (let j = 0; j < worldMatrix.length; j++) {
                clone[j] = this.imageTargetStates[i].trackingMatrix[j];
              }
              this.onUpdate({type: 'updateMatrix', targetIndex: i, worldMatrix: clone});
            }
          }
        }

        this.onUpdate({type: 'workerDone'});

        workerRunning = false;
      }
    }, 10);
  }

  workerMatch(featurePoints, skipTargetIndexes) {
    return new Promise(async (resolve, reject) => {
      this.workerMatchDone = (data) => {
        resolve({targetIndex: data.targetIndex, modelViewTransform: data.modelViewTransform});
      }
      this.worker.postMessage({type: 'match', featurePoints: featurePoints, skipTargetIndexes});
    });
  }

  workerTrack(modelViewTransform, selectedFeatures) {
    return new Promise(async (resolve, reject) => {
      this.workerTrackDone = (data) => {
        resolve(data.modelViewTransform);
      }
      this.worker.postMessage({type: 'track', modelViewTransform, selectedFeatures: selectedFeatures});
    });
  }

  // html image. this function is mostly for debugging purpose
  // but it demonstrates the whole process. good for development
  async processImage(input) {
    let featurePoints = this.detector.detect(input);
    console.log("featurePoints", featurePoints);
    const {targetIndex, modelViewTransform} = await this.workerMatch(featurePoints, []);
    console.log("match", targetIndex, modelViewTransform);
    if (targetIndex === -1) return;

    const trackFeatures = this.tracker.track(input, modelViewTransform, targetIndex);
    const modelViewTransform2 = await this.workerTrack(modelViewTransform, trackFeatures);
    console.log("track", modelViewTransform2);

    if (modelViewTransform2 === null) return;
    const worldMatrix = _glModelViewMatrix(modelViewTransform);
    console.log("world matrix", worldMatrix);
  }
}

// build openGL modelView matrix
const _glModelViewMatrix = (modelViewTransform) => {
  const openGLWorldMatrix = [
    modelViewTransform[0][0], -modelViewTransform[1][0], -modelViewTransform[2][0], 0,
    modelViewTransform[0][1], -modelViewTransform[1][1], -modelViewTransform[2][1], 0,
    modelViewTransform[0][2], -modelViewTransform[1][2], -modelViewTransform[2][2], 0,
    modelViewTransform[0][3], -modelViewTransform[1][3], -modelViewTransform[2][3], 1
  ];
  return openGLWorldMatrix;
}

// build openGL projection matrix
const _glProjectionMatrix = ({projectionTransform, width, height, near, far}) => {
  const proj = [
    [2 * projectionTransform[0][0] / width, 0, -(2 * projectionTransform[0][2] / width - 1), 0],
    [0, 2 * projectionTransform[1][1] / height, -(2 * projectionTransform[1][2] / height - 1), 0],
    [0, 0, -(far + near) / (far - near), -2 * far * near / (far - near)],
    [0, 0, -1, 0]
  ];

  const projMatrix = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      projMatrix.push(proj[j][i]);
    }
  }
  return projMatrix;
}

module.exports = {
 Controller
}
