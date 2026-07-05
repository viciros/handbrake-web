HandBrake Web uses the server as the owner of your media paths. The server reads input files from the folders you mount into the server container, sends temporary copies to workers for processing, and writes finished output files back to the selected output path.

Workers do not need the same media folders mapped. They receive a temporary input copy from the server, run HandBrakeCLI against local temporary files, and upload the finished output back to the server.

## TL;DR

Only the server container needs your media folders mapped. Mount them wherever you want inside the container, then choose those paths in Settings.

```yaml
handbrake-server:
  volumes:
    - /path/to/your/data:/data
    - /path/to/your/downloads:/downloads
    - /path/to/your/encoded:/encoded

handbrake-worker:
  volumes:
    - /mnt/cache/handbrake-web-worker-tmp:/tmp/handbrake-web
```

Workers do not need the media folders, but mapping `/tmp/handbrake-web` gives active transcodes explicit temp space outside Docker's writable container layer. The temp path needs enough space for the input file plus the output file for the job the worker is running.

## How Jobs Move Through The System

When you create a job in HandBrake Web:

- The server browses and validates files under the configured input/output paths.
- The server stores the job's input and output paths in its database.
- A worker authenticates to the server with its Web UI-generated worker token.
- The server creates a one-use input transfer token for the assigned worker.
- The worker downloads the source file to local temporary storage.
- The worker runs HandBrakeCLI against local temporary paths.
- The server creates a one-use output transfer token for the assigned worker.
- The worker uploads the finished output.
- The server writes the final file to the requested output path.

## A Simple Example

In this example, the server has `/mnt/user/downloads/complete` mapped to `/downloads`, `/mnt/user/encoded/complete` mapped to `/encoded`, and the worker has no media mount.

- The server sees `/downloads/my-video.mov`.
- A user creates a job with output `/encoded/my-transcoded-video.mkv`.
- The worker receives the job assignment.
- The worker downloads `my-video.mov` from the server into its temp directory.
- The worker creates the transcoded file in its temp directory.
- The worker uploads the transcoded file back to the server.
- The server writes `/encoded/my-transcoded-video.mkv`.

On the host, the output appears at `/mnt/user/encoded/complete/my-transcoded-video.mkv`.

## Supported Layouts

The server can use local storage, SMB/NFS, or another mounted filesystem for input and output paths, as long as the server can reliably read inputs and write outputs. Input and output folders can be separate mounts, such as `/downloads` and `/encoded`, or they can be different directories under the same mount.

Workers can run on the same host or another host without mounting the media share. For remote workers, configure `SERVER_URL` and `SERVER_PORT` so the worker can reach the server.

Worker tokens authenticate workers to the server. Use HTTPS/TLS for workers that connect over an untrusted network so the worker can verify the server and the token/media stream stays encrypted.

## What Still Needs Care

The server's selected media storage must be reliable at runtime. Cloud-drive or on-demand filesystem mounts can still fail if files are not fully available when the server tries to read them or if uploads are delayed when the server writes outputs.

The worker's temp/data storage must be large enough for active jobs. A safe rule of thumb is to allow at least the size of the input file plus the expected output file for each worker.

## Accessing Your Files Outside Containers

This is determined by your setup. If you want to access the files outside Docker, map normal host directories or network mounts into the server container, such as:

- SMB
- NFS
- FTP/SFTP
- WebDAV

## A Note On Permissions

HandBrake Web recommends specifying a non-root user for containers. The server user needs read and write permissions for `/data` and the media folders you mount, such as `/downloads` and `/encoded`. Workers need read and write permissions for their temp/data directory.

If you are running into permissions issues, adjust ownership or permissions on the host path you map into the container. For example, if your compose file uses `user: 1000:1000`, the mapped directories should be accessible to UID `1000` and GID `1000`.
