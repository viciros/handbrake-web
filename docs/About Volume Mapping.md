HandBrake Web uses the server as the owner of your media library. The server reads input files from `/video`, sends them to workers for processing, and writes finished output files back to `/video`.

Workers do not need the same media share mapped. They receive a temporary input copy from the server, run HandBrakeCLI against local temporary files, and upload the finished output back to the server.

## TL;DR

Only the server container needs your media mapped to `/video`.

```yaml
handbrake-server:
  volumes:
    - /path/to/your/data:/data
    - /path/to/your/media:/video

handbrake-worker:
  # no /video mount required
```

Workers need enough local temp/data space for the input file plus the output file for the job they are running.

## How Jobs Move Through The System

When you create a job in HandBrake Web:

- The server browses and validates files under its configured media root.
- The server stores the job's input and output paths in its database.
- A worker authenticates to the server with keypair challenge auth.
- The server creates a one-use input transfer token for the assigned worker.
- The worker downloads the source file to local temporary storage.
- The worker runs HandBrakeCLI against local temporary paths.
- The server creates a one-use output transfer token for the assigned worker.
- The worker uploads the finished output.
- The server writes the final file to the requested output path under `/video`.

## A Simple Example

In this example, the server has `/mnt/user/media/video` mapped to `/video`, and the worker has no media mount.

- The server sees `/video/input/my-video.mov`.
- A user creates a job with output `/video/output/my-transcoded-video.mkv`.
- The worker receives the job assignment.
- The worker downloads `my-video.mov` from the server into its temp directory.
- The worker creates the transcoded file in its temp directory.
- The worker uploads the transcoded file back to the server.
- The server writes `/video/output/my-transcoded-video.mkv`.

On the host, the output appears at `/mnt/user/media/video/output/my-transcoded-video.mkv`.

## Supported Layouts

The server can use local storage, SMB/NFS, or another mounted filesystem for `/video`, as long as the server can reliably read inputs and write outputs.

Workers can run on the same host or another host without mounting the media share. For remote workers, configure `SERVER_URL` and `SERVER_PORT` so the worker can reach the server.

Keypair authentication verifies that workers and the server trust each other, but it does not encrypt the media stream by itself. Use HTTPS/TLS for workers that connect over an untrusted network.

## What Still Needs Care

The server's `/video` storage must be reliable at runtime. Cloud-drive or on-demand filesystem mounts can still fail if files are not fully available when the server tries to read them or if uploads are delayed when the server writes outputs.

The worker's temp/data storage must be large enough for active jobs. A safe rule of thumb is to allow at least the size of the input file plus the expected output file for each worker.

## Accessing Your Files Outside Containers

This is determined by your setup. If you want to access the files outside Docker, map `/video` from a normal host directory or a network mount such as:

- SMB
- NFS
- FTP/SFTP
- WebDAV

## A Note On Permissions

HandBrake Web recommends specifying a non-root user for containers. The server user needs read and write permissions for `/data` and `/video`. Workers need read and write permissions for their temp/data directory.

If you are running into permissions issues, adjust ownership or permissions on the host path you map into the container. For example, if your compose file uses `user: 1000:1000`, the mapped directories should be accessible to UID `1000` and GID `1000`.
