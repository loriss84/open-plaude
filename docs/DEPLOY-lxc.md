# Production deploy — Proxmox LXC + NFS + systemd

A full walkthrough for running open-plaud on a single Debian LXC: NFS (bind-mounted
from the host), the poller+dashboard, and n8n.

> Replace every `<PLACEHOLDER>` with your own values.

Variables used below:

```
VMID=<LXC_ID>                     # e.g. 108
NAS_IP=<NAS_IP>                   # e.g. 10.0.0.10
NAS_EXPORT=<NFS_EXPORT>           # e.g. /volume1/YourShare   (verify with: showmount -e <NAS_IP>)
SUBDIR=plaud                      # dedicated subfolder: <NFS_EXPORT>/plaud
HOST_MNT=/mnt/plaud-nfs           # mount point on the Proxmox host
LXC_MNT=/mnt/nfs/plaud            # path inside the container
```

---

## 0. Enable NFS on your NAS

Create/choose a shared folder and enable NFS access for it (Read/Write) from your
Proxmox host's subnet. Then verify from the host:

```bash
apt-get install -y nfs-common
showmount -e <NAS_IP>     # should list your export
```

> **Unprivileged LXC permission note:** an unprivileged container writes as a high,
> remapped uid that your NAS won't recognize. The simplest fix is to make the target
> subfolder world-writable from the host after mounting (`chmod 777`), or configure
> your NAS NFS squash to map all users to a writable account. See step 2.

## 1. Create the LXC (Proxmox host)

```bash
pveam update
pveam download local debian-12-standard_12.7-1_amd64.tar.zst   # or debian-13

pct create <LXC_ID> local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname plaud-n8n \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs local-lvm:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 \
  --onboot 1
pct start <LXC_ID>
pct exec <LXC_ID> -- ip -4 addr show eth0 | grep inet     # note the LXC IP
```

## 2. NFS on host + bind-mount into the LXC

```bash
# on the Proxmox host
mkdir -p /mnt/plaud-nfs
echo '<NAS_IP>:<NFS_EXPORT>  /mnt/plaud-nfs  nfs  defaults,_netdev,vers=3  0 0' >> /etc/fstab
mount -a
mkdir -p /mnt/plaud-nfs/plaud
chmod 777 /mnt/plaud-nfs/plaud            # lets the unprivileged container write

# bind-mount the subfolder into the container
pct set <LXC_ID> -mp0 /mnt/plaud-nfs/plaud,mp=/mnt/nfs/plaud
pct reboot <LXC_ID>

# verify inside the container
pct enter <LXC_ID>
touch /mnt/nfs/plaud/.test && echo "write OK" && rm /mnt/nfs/plaud/.test
```

## 3. Node + the poller (inside the LXC)

```bash
apt update && apt install -y curl git ffmpeg openssh-server

# Node 22 (required by n8n's native deps; works for the poller too)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # >= 20

# dedicated user + clone plaud-toolkit
useradd -r -m -d /home/plaud plaud
git clone https://github.com/sergivalverde/plaud-toolkit.git /opt/plaud-toolkit
cd /opt/plaud-toolkit && npm install

# copy this repo's poller files into the toolkit, then:
chown -R plaud:plaud /opt/plaud-toolkit
```

Copy `poller/*.ts` into `/opt/plaud-toolkit/` (e.g. via `scp` from your machine).

### Login (one-time)

```bash
cd /opt/plaud-toolkit
runuser -u plaud -- env HOME=/home/plaud PLAUD_CONFIG_DIR=/home/plaud/.plaud \
  PLAUD_EMAIL='you@example.com' PLAUD_PASSWORD='your-password' PLAUD_REGION=eu \
  npx tsx plaud-login.ts        # expect: Login OK
```

### Service (dashboard + scheduler)

```bash
install -m 600 -o plaud -g plaud /dev/null /etc/plaud-gui.env
printf 'PLAUD_GUI_USER=admin\nPLAUD_GUI_PASSWORD=<STRONG_PASSWORD>\nPLAUD_CONFIG_DIR=/home/plaud/.plaud\n' > /etc/plaud-gui.env

cp /path/to/systemd/plaud-gui.service /etc/systemd/system/
sed -i '/Environment=PLAUD_DATA_DIR/a EnvironmentFile=/etc/plaud-gui.env' /etc/systemd/system/plaud-gui.service
mkdir -p /opt/plaud-toolkit/data && chown plaud:plaud /opt/plaud-toolkit/data

systemctl daemon-reload
systemctl enable --now plaud-gui.service
journalctl -u plaud-gui.service -f
```

Dashboard: `http://<LXC_IP>:8787` (Basic auth with the credentials above).

## 4. n8n (npm + systemd)

```bash
apt install -y build-essential python3       # for native deps
npm install -g n8n
useradd -r -m -d /home/n8n n8n
mkdir -p /opt/n8n && chown -R n8n:n8n /opt/n8n

cp /path/to/systemd/n8n.service /etc/systemd/system/
N8N_BIN=$(which n8n); sed -i "s|ExecStart=.*|ExecStart=$N8N_BIN start|" /etc/systemd/system/n8n.service
systemctl daemon-reload
systemctl enable --now n8n.service
```

Open `http://<LXC_IP>:5678`, create the owner account, import the workflow from
`n8n/`, set up credentials, and **activate** it. Then in the poller dashboard set the
webhook URL to `http://localhost:5678/webhook/plaud` and enable it.

> Debian 13 note: n8n's `isolated-vm` needs Node 22's V8; also `pip install
> "setuptools<74"` if `node-gyp` complains about missing `distutils` (Python 3.13).

## Notes

- Keep ports `:8787` and `:5678` on LAN/VPN, or behind an HTTPS reverse proxy.
- Back up `/home/plaud/.plaud/config.json` (Plaud token) and your n8n workflows.
- This is an unofficial Plaud integration and can break if the API changes.
