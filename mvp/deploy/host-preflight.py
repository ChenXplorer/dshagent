"""Read-only Linux host evidence for real MVP deployment. Prints no credentials."""
import datetime
import json
import os
import pathlib
import platform
import shutil
import subprocess


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {"exitCode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": type(error).__name__}


def disk(path):
    usage = shutil.disk_usage(path)
    return {"path": path, "totalBytes": usage.total, "availableBytes": usage.free}


cpuinfo = pathlib.Path('/proc/cpuinfo').read_text()
flags = set()
for line in cpuinfo.splitlines():
    if line.startswith('flags'):
        flags.update(line.partition(':')[2].split())

result = {
    "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": platform.node(),
    "kernel": platform.release(),
    "architecture": platform.machine(),
    "cpuCount": os.cpu_count(),
    "virtualization": command(['systemd-detect-virt']),
    "kvmDeviceExists": pathlib.Path('/dev/kvm').exists(),
    "hardwareVirtualizationFlags": sorted(flags.intersection({'vmx', 'svm'})),
    "memory": command(['free', '-b']),
    "disks": [disk('/'), disk('/home')],
    "filesystems": command(['findmnt', '-n', '-o', 'TARGET,FSTYPE,SOURCE', '-T', '/home']),
    "node": command(['node', '--version']),
    "dockerRoot": command(['docker', 'info', '--format', '{{.DockerRootDir}}']),
    "inotify": {
        "maxUserInstances": command(['cat', '/proc/sys/fs/inotify/max_user_instances']),
        "maxUserWatches": command(['cat', '/proc/sys/fs/inotify/max_user_watches']),
        "maxQueuedEvents": command(['cat', '/proc/sys/fs/inotify/max_queued_events']),
    },
}
print(json.dumps(result, indent=2))
