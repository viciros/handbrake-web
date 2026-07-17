## Docker Compose

Currently, Docker/Docker Compose are the only officially supported methods of installing HandBrake Web.

### Minimum Requirements

#### Host Machine/Operating System

You will need a host machine capable of running the Docker Engine:

- Linux (Recommended) - A native & bare-metal installation of a Linux distribution is the project's recommendation.
- Windows - Ensure you have WSL2 and/or Docker Desktop installed.
- MacOS - Ensure you have Docker Desktop installed.

You may face additional hurdles on Windows and MacOS.

#### Software/Drivers

You will need to have the following installed/available on your host system:

- Docker
- Docker Compose

Docker has fantastic installation docs that cover a wide variety of OS/Distribution options, check it out [here](https://docs.docker.com/engine/install/). You can also install Docker Desktop, which you can read about [here](https://docs.docker.com/desktop/).

If you have a GPU you wish to use for hardware accelerated encoding, please ensure you have the necessary drivers/tools installed on the host system. For additional information, please see the wiki page for [[Hardware Acceleration]].

### Step 1 - Download/Copy `compose.yaml` Template

HandBrake Web has three Docker Compose configuration file templates available:

| Configuation File                                                                                           | Description                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [compose.base.yaml](https://github.com/viciros/handbrake-web/blob/main/compose/compose.base.yaml)     | Basic configuration for CPU encoding                            |
| [compose.intel.yaml](https://github.com/viciros/handbrake-web/blob/main/compose/compose.intel.yaml)   | Modified configuration for Intel QSV support for Intel GPUs     |
| [compose.nvidia.yaml](https://github.com/viciros/handbrake-web/blob/main/compose/compose.nvidia.yaml) | Modified configuration for NVIDIA NVENC support for NVIDIA GPUs |

You can either copy/paste the contents of these files into a file called `compose.yaml`, or run the following commands to download the templates directly to your current directory. All of these templates will guide you to deploy a single server instance, and a single worker instance - both running on the same machine.

##### Base

```bash
wget -O compose.yaml https://raw.githubusercontent.com/viciros/handbrake-web/refs/heads/main/compose/compose.base.yaml
```

##### Intel

```bash
wget -O compose.yaml https://raw.githubusercontent.com/viciros/handbrake-web/refs/heads/main/compose/compose.intel.yaml
```

##### NVIDIA

```bash
wget -O compose.yaml https://raw.githubusercontent.com/viciros/handbrake-web/refs/heads/main/compose/compose.nvidia.yaml
```

### Step 2 - Modify `compose.yaml` Template

You will want to modify/configure the following options in your `compose.yaml`:

#### `user` Mapping

```yaml
user: 1000:1000
```

The container will run as UID `1000` and GID `1000` by default. Depending on your host system/user configuration, you may need to change this in order to avoid permissions issues. You can run the command `id` on your host system to get the UID/GID of your current user or another user.

You may opt to run the container as root `0:0` to almost certainly bypass any permissions issues, but this is not recommended.

#### `ports` Mapping

```yaml
ports:
  - 9999:9999
```

The server will be accessible on port `9999` by default. You may change the left-hand side of this statement if you have a conflicting service already using this port.

#### `volumes` Mapping

Server:

```yaml
volumes:
  - /path/to/your/data:/data
  - /path/to/your/downloads:/downloads
  - /path/to/your/encoded:/encoded
```

Worker:

```yaml
volumes:
  - /mnt/cache/handbrake-web-worker-tmp:/tmp/handbrake-web
```

HandBrake Web expects `/data` to be mapped on the server, plus whichever media folders you want the server to browse. You can mount those folders anywhere in the container, such as `/downloads` and `/encoded`, then choose them on the Settings page as the default input and output paths. With the example above, set `Default Input Path` to `/downloads` and `Default Output Path` to `/encoded`.

Workers no longer need access to the media share; the server streams source files to workers and receives finished outputs back. Workers use `/tmp/handbrake-web` as temp/data space while a job is active, so mapping it to host storage keeps large active transcodes out of Docker's writable container layer. Make sure the worker host path has enough free space for one input file plus one output file.

See [here](https://github.com/viciros/handbrake-web/wiki/about-volume-mapping) for more information.

#### `environment` Variables

On each server start until the web UI credentials are changed, HandBrake Web logs a generated temporary password for the default username `admin`. If the server restarts before you change it, a new temporary password is generated and the previous one stops working. Sign in with the latest credentials, then change the password when prompted. You can also change the username. The password is stored only as a salted hash in the server database.

After signing in, create a worker token on the Workers page. The token is shown once. Copy it into the worker's `WORKER_TOKEN` environment variable before starting that worker.

In your worker configuration, ensure the following environment variables are properly configured:

```yaml
environment:
  - WORKER_ID=handbrake-worker
  - WORKER_TOKEN=copy-token-created-in-workers-page
  - SERVER_URL=http://handbrake-server:9999
```

- `WORKER_ID` - This must be unique and not used by any other worker connected to your server.
- `WORKER_TOKEN` - Create this on the Workers page in the server Web UI. The server stores only a hash and will not show the raw token again.
- `SERVER_URL` - The full URL workers use to reach the server. Include `http://` or `https://`; if no port is included, workers use port `80` for HTTP and `443` for HTTPS. Include the port in the URL, such as `http://handbrake-server:9999`, when the server uses a non-default port.

Worker tokens authenticate workers to the server. HTTPS/TLS lets remote workers verify the server and keeps tokens and media streams encrypted over untrusted networks.

Workers remain running and retry the server indefinitely with capped backoff when the server is unavailable, rejects authentication, or requests a disconnect. Disabling a worker in the Workers page prevents new job assignments without disconnecting it; an active job is allowed to finish. Rotate or revoke the worker token when you need to invalidate authentication.

Connected workers report container CPU and RAM usage to the Workers page every 10 seconds when Linux cgroup metrics are available.

The server waits for watched files to have unchanged size and modification time for 60 seconds before adding them to the queue. Set `HANDBRAKE_WATCHER_STABILITY_SECONDS` in the server container environment to change the quiet period:

```yaml
environment:
  - HANDBRAKE_WATCHER_STABILITY_SECONDS=60
```

### Step 3 - Start Containers

At this point, you should be good to go. Run the following command:

```bash
docker compose pull && docker compose up -d
```

This will first pull the images (based on the tag `latest`), then start the containers with the configuration you provided via `compose.yaml`. You should be able to access the HandBrake Web web interface in the browser of your choice at `http://<your-server-ip>:9999` if you did not change the port mapping!

### Post Install Recommendations

#### Hardware Encoding Support

Please see the wiki page on [Hardware Acceleration](https://github.com/viciros/handbrake-web/wiki/hardware-acceleration) for more information.

#### Reverse Proxy

In order to access HandBrake Web via URL, rather than IP, it is recommended to get setup with a **_reverse proxy_**. Some projects that I have used to accomplish this are:

- [NGINX Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager) - Simple, straight-forward setup and configuration.
- [Traefik](https://github.com/traefik/traefik) - Integrates well with Docker, but has a more complicated initial setup.

I've seen others recommend [Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy), [SWAG](https://github.com/linuxserver/docker-swag), and plain ol' NGINX - but I have not used these methods.

#### Additional Workers

To run additional workers, simply launch additional worker container instances on different machines by omitting the `handbrake-server` service from the example compose file. **Reminder** - It is recommended to run only one worker instance per machine, as a single worker will very likely push most CPUs to 100% utilization during encoding.

Because of this, your server instance must be reachable outside of the machine it is running on. In most cases the port mapping should make this work, but if you are running an additional firewall, ets. please configure accordingly.
