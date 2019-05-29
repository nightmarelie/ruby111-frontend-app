'use strict';

const https = require('https');
const url = require('url');
const fs = require('fs');
const AWS = require('aws-sdk');
const AdmZip = require('adm-zip');
const async = require('async');
const mime = require('mime');

const { SLACK_HOOK_URL, CLOUD_FRONT_DISTRIBUTION_ID } = process.env;

const statuses = {
  started: 'STARTED'
  , succeeded: 'SUCCEEDED'
  , success: 'SUCCESS'
  , failed: 'FAILED'
  , resumed: 'RESUMED'
};

const constants = {
  SUCCESS: 'SUCCESS'
  , FAILED: 'FAILED'
  , UPDATE: 'Update'
  , CREATE: 'Create'
  , DELETE: 'Delete'
};

const s3 = new AWS.S3({ signatureVersion: 'v4' });

const push_message = (message, hook_url, done) => {
  const { host: hostname, pathname: path } = url.parse(hook_url);

  const options = {
    hostname
    , port: 443
    , path
    , method: 'POST'
    , headers: {
      'Content-Type': 'application/json'
    }
  };

  console.log(JSON.stringify(options));

  const req = https.request(options, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      console.log('data');
      done(null, chunk);
    });
    res.on('end', () => {
      console.log('end');
      done(null, null);
    });
  });

  req.on('error', err => done(err, null));

  // write data to request body
  console.log(JSON.stringify(message));
  req.write(JSON.stringify(message));
  req.end();
};

exports.notify_slack_of_pipeline_changes = (event, context) => {
  console.log('event:', event);

  const { detail: { stage, state, pipeline }, region } = event;

  const project = `ruby111FrontEnd_${stage.toLowerCase()}_build`;
  const log_link = `https://console.aws.amazon.com/cloudwatch/home?region=${region}#logEventViewer:group=/aws/codebuild/${project};start=P1D`;
  const log_button = {
    fallback: `View build logs ${log_link}`
    , actions: [
      {
        type: 'button'
        , text: 'View build logs'
        , url: log_link
      }
    ]
  };

  const message = {
    username: 'pipeline-bot'
    , icon_emoji: ':rocket:'
    , attachments: [
      {
        pretext: `Pipeline entered *[${stage}]* phaze.`
        , title: 'Pipeline execution details'
        , title_link: `https://${region}.console.aws.amazon.com/codepipeline/home?region=${region}#/view/${pipeline}`
        , color: (state === statuses.failed) ? 'danger' : 'good'
        , fields: [
          {
            title: 'STATUS'
            , value: state
            , short: true
          }
          , {
            title: 'STAGE'
            , value: stage
            , short: true
          }
        ]
      }
    ]
  };

  // add view logs button if pipeline failed
  if (state === statuses.failed) message.attachments.push(log_button);

  push_message(
    message
    , SLACK_HOOK_URL
    , (err, results) => {
      return err ? context.fail(err) : context.succeed(results);
    }
  );
};

exports.handler = (event, context, callback) => {
  console.log(event);

  const { LogicalResourceId, RequestType: requestType, ResourceProperties: { Options } } = event;

  const resourceOptions = requestType === constants.DELETE ? {} : Options;

  if (LogicalResourceId !== 'WebsiteDeployment') {
    return sendCloudFormationResponse(constants.FAILED, { message: `Invalid LogicalResourceId: ${LogicalResourceId}` })
  }

  switch (requestType) {
    case constants.CREATE:
    case constants.UPDATE:
      return uploadArtifacts(resourceOptions);
    case constants.DELETE:
      return cleanBucket(event.PhysicalResourceId);
    default:
      return sendCloudFormationResponse(constants.FAILED, { message: `Invalid request type ${requestType}` });
  }

  function cleanBucket(resourceId) {
    if (!resourceId) {
      return sendCloudFormationResponse(constants.FAILED, { message: `Invalid physical resource id: ${resourceId}` })
    }
    const [, Bucket] = resourceId.split('::');

    s3.listObjects({ Bucket }, (err, data) => {
      if (err) {
        return sendCloudFormationResponse(constants.FAILED, {message: `Could not list bucket objects: ${err}`})
      }

      data.Contents.forEach(({Key}) => {
        s3.deleteObject({Bucket, Key}, err => {
          if (err) {
            return sendCloudFormationResponse(constants.FAILED, {message: `Could not delete object: ${Key}`})
          }
        })
      });
    });

    return sendCloudFormationResponse(constants.SUCCESS, { message: 'OK' }, resourceId);
  }

  function uploadArtifacts(resourceOptions) {
    if (!resourceOptions || !resourceOptions.SourceBucket
        || !resourceOptions.SourceArtifact
        || !resourceOptions.DestinationBucket
    ) {
      return sendCloudFormationResponse(constants.FAILED, {
        message: 'Missing required options: SourceBucket, SourceArtifact, DestinationBucket'
      });
    }
    const {
      SourceBucket: sourceBucket
      , SourceArtifact: sourceArtifact
      , DestinationBucket: destinationBucket
    } = resourceOptions;

    const physicalResourceId = `Deployment::${destinationBucket}`;

    const tmpSourceArtifact = '/tmp/artifact.zip';
    const tmpPackageZip = '/tmp/package.zip';

    // get source artifact
    s3.getObject({ Bucket: sourceBucket, Key: sourceArtifact }, (err, data) => {
      if (err) {
        return sendCloudFormationResponse(constants.FAILED, { message: `Could not fetch artifact: ${sourceBucket}/${sourceArtifact}: ${err}` })
      }

      try {
        fs.writeFileSync(tmpSourceArtifact, data.Body, { encoding: 'binary' });
      } catch (ex) {
        return sendCloudFormationResponse(constants.FAILED, { message: `Could not save artifact to disk: ${ex}` });
      }

      const artifactZip = new AdmZip(tmpSourceArtifact);
      let packageFound = false;

      const zipEntries = artifactZip.getEntries();

      zipEntries.forEach(zipEntry => {
        if (zipEntry.entryName === 'package.zip') {
          console.log('Found package.zip file');

          packageFound = true;

          try {
            artifactZip.extractEntryTo(zipEntry, '/tmp', true, true);
          } catch (ex) {
            return sendCloudFormationResponse(constants.FAILED, { message: `Could not save package to disk: ${ex}` });
          }
        }
      });

      if (!packageFound) {
        return sendCloudFormationResponse(constants.FAILED, { message: 'Could not package.zip in artifact' });
      }

      const deploymentDir = '/tmp/dist';

      if (fs.existsSync(deploymentDir)) deleteFolderRecursive(deploymentDir);

      fs.mkdirSync(deploymentDir);

      const packageZip = new AdmZip(tmpPackageZip);
      const packageEntries = packageZip.getEntries();
      const asyncTasks = [];

      packageEntries.forEach((entry) => {
        console.log(`Processing entry ${entry.entryName}`);

        if (entry.isDirectory) return;

        asyncTasks.push((callback) => {
          packageZip.extractEntryTo(entry, deploymentDir, true, true);

          const fileName = `${deploymentDir}/${entry.entryName}`;
          const fileData = fs.readFileSync(fileName);

          const s3FileProperties = {
            Bucket: destinationBucket
            , Key: entry.entryName
            , ContentLength: fileData.length
            , Body: fileData
            , ContentType: mime.getType(fileName)
          };

          s3.putObject(s3FileProperties, (_err, _data) => {
            if (_err) callback(_err, entry.entryName);
            else callback(null, _data.Key);
          });
        });
      });

      async.parallel(asyncTasks, (_err, result) => {
        if (_err) {
          return sendCloudFormationResponse(constants.FAILED, { message: `Error while uploading ${result} to destination bucket: ${err}` });
        } else {
          if (CLOUD_FRONT_DISTRIBUTION_ID) {
            // const invalidateCloudFront = function() {
            const cloudfront = new AWS.CloudFront();
            const params = {
              DistributionId: CLOUD_FRONT_DISTRIBUTION_ID
              , InvalidationBatch: {
                CallerReference: Date.now().toString()
                , Paths: {
                  Quantity: 1
                  , Items: [
                    '/*'
                  ]
                }
              }
            };

            cloudfront.createInvalidation(params, (_err, data) => {
              if (_err) sendCloudFormationResponse(constants.FAILED, { message: `Error while uploading ${result} to destination bucket: ${_err}` });

              sendCloudFormationResponse(constants.SUCCESS, { message: 'OK' }, physicalResourceId);
            });

            return;
          }
          sendCloudFormationResponse(constants.SUCCESS, { message: 'OK' }, physicalResourceId);
        }
      });
    });

    function deleteFolderRecursive(path) {
      if (fs.existsSync(path)) {
        fs
          .readdirSync(path)
          .forEach((file) => {
            const curPath = `${path}/${file}`;

            if (fs.lstatSync(curPath).isDirectory()) deleteFolderRecursive(curPath); // recurse
            else fs.unlinkSync(curPath); // delete file
          });

        fs.rmdirSync(path);
      }
    }
  }

  function sendCloudFormationResponse(responseStatus, responseData, physicalResourceId) {
    const responseBody = JSON.stringify({
      Status: responseStatus
      , Reason: `See the details in CloudWatch Log Stream: ${context.logStreamName}`
      , PhysicalResourceId: physicalResourceId || context.logStreamName
      , StackId: event.StackId
      , RequestId: event.RequestId
      , LogicalResourceId: event.LogicalResourceId
      , Data: responseData
    });

    console.log(`Response body: ${responseBody}`);

    const parsedUrl = url.parse(event.ResponseURL);
    const requestOptions = {
      hostname: parsedUrl.hostname
      , port: 443
      , path: parsedUrl.path
      , method: 'PUT'
      , headers: {
        'content-type': ''
        , 'content-length': responseBody.length
      }
    };

    return new Promise((resolve, reject) => {
      const request = https.request(requestOptions, resolve);

      request.on('error', e => reject(`http request error: ${e}`));
      request.write(responseBody);
      request.end();
    })
      .then(() => callback(responseStatus === constants.FAILED ? responseStatus : null, responseData))
      .catch(callback);
  }
};
