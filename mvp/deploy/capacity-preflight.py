#!/usr/bin/env python3
"""Read-only capacity gate for a planned DSH multi-tenant execution wave.

The script deliberately requires operator-supplied observations for Sandbox,
Daemon and CLI memory.  It does not infer a capacity number from the control
plane user count, start a Sandbox, or read any credential.
"""
import argparse
import json
import os
import pathlib
import shutil
import sys


MIB = 1024 * 1024


def positive(value: str) -> int:
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError('must be greater than zero')
    return result


def nonnegative(value: str) -> int:
    result = int(value)
    if result < 0:
        raise argparse.ArgumentTypeError('must not be negative')
    return result


def mem_available() -> int:
    values = {}
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        key, raw = line.split(':', 1)
        values[key] = int(raw.strip().split()[0]) * 1024
    if 'MemAvailable' not in values:
        raise RuntimeError('/proc/meminfo has no MemAvailable')
    return values['MemAvailable']


def kernel_limit(name: str):
    path = pathlib.Path('/proc/sys') / name.replace('.', '/')
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


parser = argparse.ArgumentParser(description='Read-only DSH/Daytona execution capacity gate')
parser.add_argument('--active-sandboxes', type=positive, required=True,
                    help='Sandboxes planned in this wave, not total registered tenants')
parser.add_argument('--concurrent-tasks', type=positive, required=True,
                    help='Total CLI tasks planned at the same time in this wave')
parser.add_argument('--sandbox-mib', type=positive, required=True,
                    help='Observed peak MiB per active Sandbox, including its default Daemon')
parser.add_argument('--task-mib', type=nonnegative, required=True,
                    help='Observed additional peak MiB per concurrent CLI task')
parser.add_argument('--control-plane-mib', type=positive, required=True,
                    help='Observed MiB for Hub, Gateway, Daytona and shared services')
parser.add_argument('--reserve-mib', type=positive, required=True,
                    help='MiB intentionally left free for kernel, cache and recovery')
parser.add_argument('--disk-mib', type=positive, required=True,
                    help='New /home disk space required by this wave, including artifacts and logs')
parser.add_argument('--host-path', default='/home', help='Filesystem that will hold Daytona state (default: /home)')
args = parser.parse_args()

available_memory = mem_available()
available_disk = shutil.disk_usage(args.host_path).free
required_memory = (args.active_sandboxes * args.sandbox_mib +
                   args.concurrent_tasks * args.task_mib +
                   args.control_plane_mib + args.reserve_mib) * MIB
required_disk = args.disk_mib * MIB
checks = {
    'memory': {
        'ok': available_memory >= required_memory,
        'availableMiB': available_memory // MIB,
        'requiredMiB': required_memory // MIB,
    },
    'disk': {
        'ok': available_disk >= required_disk,
        'path': os.path.abspath(args.host_path),
        'availableMiB': available_disk // MIB,
        'requiredMiB': args.disk_mib,
    },
    'inotify': {
        # A DSH Host watches its Profile and Skills.  This is a conservative
        # readiness floor, not a claim that it measures every other watcher.
        'ok': (kernel_limit('fs.inotify.max_user_instances') or 0) >= max(1024, args.active_sandboxes),
        'maxUserInstances': kernel_limit('fs.inotify.max_user_instances'),
        'minimumForWave': max(1024, args.active_sandboxes),
    },
}
result = {
    'readOnly': True,
    'plan': {
        'activeSandboxes': args.active_sandboxes,
        'concurrentTasks': args.concurrent_tasks,
        'sandboxMiB': args.sandbox_mib,
        'taskMiB': args.task_mib,
        'controlPlaneMiB': args.control_plane_mib,
        'reserveMiB': args.reserve_mib,
        'diskMiB': args.disk_mib,
    },
    'checks': checks,
    'ready': all(check['ok'] for check in checks.values()),
}
print(json.dumps(result, indent=2))
sys.exit(0 if result['ready'] else 2)
