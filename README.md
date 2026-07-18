<div align='center'>
    <h1 style='{text-decoration: none}'>HandBrake Web</h1>
    <div align='center'>
      <a href='https://github.com/viciros/handbrake-web/blob/main/LICENSE'>
        <img alt="GitHub License" src="https://img.shields.io/github/license/viciros/handbrake-web?style=flat-square">
      </a>
      <a href='https://github.com/viciros/handbrake-web/releases/latest'>
        <img alt="GitHub Release" src="https://img.shields.io/github/v/release/viciros/handbrake-web?style=flat-square">
      </a>
      <a href='https://github.com/viciros/handbrake-web/milestone/7'>
        <img alt="GitHub package.json version" src="https://img.shields.io/badge/development-v0.9.0-goldenrod?style=flat-square">
      </a>
      <a href='https://github.com/viciros/handbrake-web/milestone/7'>
        <img alt="GitHub milestone details" src="https://img.shields.io/github/milestones/progress-percent/viciros/handbrake-web/7?style=flat-square&label=progress&color=goldenrod">
      </a>
      <a href='https://github.com/viciros/handbrake-web/actions/workflows/docker-publish.yaml?query=branch%3Amain'>
        <img alt="GitHub Actions Workflow Status" src="https://img.shields.io/github/actions/workflow/status/viciros/handbrake-web/docker-publish.yaml?branch=main&style=flat-square">
      </a>
      <a href='https://buymeacoffee.com/thenickoftime'>
        <img alt="Static Badge" src="https://img.shields.io/badge/support-buy_me_a_coffee-mediumseagreen?style=flat-square">
      </a>
    </div>
    <div align='center'>
      <strong>Disclaimer:</strong>
      <em>This project is not related to or part of the official <a href='https://github.com/HandBrake/HandBrake'>HandBrake</a> development. It simply uses the CLI component of HandBrake under the hood.</em>
    </div>
    <img src='client/public/handbrake-icon.png' height=256px>
</div>

## Summary

<div align='center' width=100%>
  <img src='/docs/images/screenshots/screenshot-queue.png' width=90%>
  <details>
    <summary><strong>See More Screenshots (<em>click to expand</em>)</strong></summary>
    <img src='/docs/images/screenshots/screenshot-dashboard.png' width=90%>
    <img src='/docs/images/screenshots/screenshot-presets.png' width=90%>
    <img src='/docs/images/screenshots/screenshot-watchers.png' width=90%>
    <img src='/docs/images/screenshots/screenshot-workers.png' width=90%>
    <img src='/docs/images/screenshots/screenshot-settings.png' width=90%>
  </details>
</div>

HandBrake Web is a program for interfacing with handbrake across multiple machines via a web browser. It consists of two components: the **server** and one or more **worker**(s). **_Warning_** - This application is still under heavy development, use at your own risk, to learn more please see the [Known Issues & Limitations](#planned-features-not-yet-implemented) section.

### Server

The server component primarily acts as a coordinator for the workers. Additionally it serves the client interface. **The work done by the server is not computationally expensive** - it can be run on low-end/low-power devices with no issue.

### Worker(s)

The worker component does the heavy lifting via HandBrakeCLI. Jobs are sent to workers by the server, and the workers will process the provided media based on a provided HandBrake preset configuration. **The work done by the worker is very computationally expensive** - it is recommended that you **run a single worker instance per machine**, and that machine either have a high core-count CPU _or_ have GPU hardware encoding features available to the worker.

## Setup

### Setup Guide

See the [Setup Guide](https://github.com/viciros/handbrake-web/wiki/Setup-Guide) wiki page for a detailed walkthrough on getting HandBrake Web setup and configured.

### Quick Start

If you are very familiar with Docker/Docker Compose and want to get started as fast as possible with a server and a single worker, check out the base configuration below:

```yaml
services:
  handbrake-server:
    image: ghcr.io/viciros/handbrake-web-server:latest
    container_name: handbrake-web-server
    restart: unless-stopped
    user: 1000:1000 # edit to run as user (uuid:guid) with permissions to access your media. 0:0 to run as root (not recommended).
    ports:
      - 9999:9999
    volumes:
      - /path/to/your/data:/data
      - /path/to/your/downloads:/downloads # choose as the default input path in Settings
      - /path/to/your/encoded:/encoded # choose as the default output path in Settings

  handbrake-worker:
    image: ghcr.io/viciros/handbrake-web-worker:latest
    container_name: handbrake-web-worker
    restart: unless-stopped
    user: 1000:1000 # edit to run as user (uuid:guid) with permissions to access your media. 0:0 to run as root (not recommended).
    environment:
      - WORKER_ID=handbrake-worker # give your worker a unique name
      - WORKER_TOKEN=copy-token-created-in-workers-page # create this on the Workers page
      - SERVER_URL=http://handbrake-server:9999 # change if setting up a standalone worker or reverse proxy
    volumes:
      - /mnt/cache/handbrake-web-worker-tmp:/tmp/handbrake-web # worker temp space for active transcodes
    depends_on:
      - handbrake-server
```

On each server start until the web UI credentials are changed, HandBrake Web logs a generated temporary password for the default username `admin`. If the server restarts before you change it, a new temporary password is generated and the previous one stops working. Sign in with the latest credentials, then change the password when prompted. You can also change the username. The password is stored only as a salted hash in the server database.

Create a token for each worker on the Workers page, then put the one-time token value into that worker's `WORKER_TOKEN` environment variable. Set the worker's `SERVER_URL` to the full server URL, including the scheme and any non-default port. For remote workers outside a trusted local network, expose the server over HTTPS/TLS and use an `https://` URL.

Workers retry server connections indefinitely with capped backoff, including after authentication failures and server-requested disconnects. Disabling a worker in the web UI keeps it authenticated and connected, lets active work finish, and prevents new job assignments. Rotate or revoke its token when you need to invalidate authentication and disconnect the worker.

Every 10 seconds, each worker reports CPU and memory utilization for the Linux Docker host where that worker is running. Memory used is derived from Linux `MemAvailable` so reclaimable cache is handled correctly. Workers on the same Docker host report the same host-wide resource usage. These metrics use `/proc/stat` and `/proc/meminfo` and do not require privileged container access.

Watch folders wait until a file's size and modification time have both remained unchanged for 60 seconds before creating a job. Set `HANDBRAKE_WATCHER_STABILITY_SECONDS` on the server to change this quiet period for slower or faster storage.

## Usage

### Presets

HandBrake Web currently uses presets configured in the desktop application of HandBrake and exported to .json files to configure encoding jobs. Exported presets can then be uploaded via the web interface in the 'Presets' section. Please see the [Presets](https://github.com/viciros/handbrake-web/wiki/Presets) wiki page for additional information.

### Hardware Accelerated Encoding

Additional configuration is required to enable hardware accelerated encoding for GPUs - please see the [Hardware Acceleration](https://github.com/viciros/handbrake-web/wiki/Hardware-Acceleration) wiki page for additional information. Currently Intel QSV and NVIDIA NVENC hardware encoding are supported. Support for AMD VCN is planned, but not yet implimented.

## Features

_These lists are not comprehensive, please see the [project repository](https://github.com/viciros/handbrake-web) for more information..._

### Current Features

- **Web Interface** - Interact with HandBrake on a headless device via a web browser.
- **Job Queue** - Create and manage a queue of jobs for your workers to tackle in order.
- **Bulk Job Creation** - Easily create multiple jobs at once for videos in the same directory.
- **Preset Management** - Upload, Rename, and Delete HandBrake presets in the web interface.
- **Directory Monitoring** - Create directory _"Watchers"_ to automatically create jobs based on various criteria.
- **Distributed Encoding** - Leverage multiple devices/nodes/workers to tackle encoding tasks concurrently.
- **Hardware Accelerated Encoding** - Use a GPU to speed up encoding times.
  - **Intel QSV** - Use your discrete and/or integrated Intel GPU.
  - **NVIDIA NVENC** - Use your discrete NVIDIA GPU.

### Planned Features (not yet implemented)

- **Preset Creator** - Create presets directly in the web interface.
- **Upload Files** - Upload video files to the server via the web interface.
- **Hardware Accelerated Encoding** - Use a GPU to speed up encoding times.
  - **AMD VCN** - Use your discrete and/or integrated AMD GPU.
- **User Sessions** - Logging in required to access the web interface.

## Bonus Tool (Minimal HandBrakeCLI Image)

If you are looking for a dockerized/containerized way to directly use HandBrakeCLI (via terminal), you can use an additional image this project provides -`ghcr.io/viciros/handbrake-cli`. You can find additional information about using it on the [HandBrakeCLI Image](https://github.com/viciros/handbrake-web/wiki/HandBrakeCLI-Image) wiki page.

This "bonus" image was incredibly simple to make by using the existing outputs of this project's build process, so it felt rude to not make it available to anyone who might want to use it.

## Contributing & Development

Please see [CONTIBUTING.md](./CONTRIBUTING.md).
