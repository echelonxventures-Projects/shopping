#!/bin/sh
# Import the platform image into k3s containerd (run INSIDE the colima VM).
sudo /usr/local/bin/k3s ctr --address /run/containerd/containerd.sock -n k8s.io images import /tmp/aether-platform.tar
sudo /usr/local/bin/k3s ctr --address /run/containerd/containerd.sock -n k8s.io images ls | grep aether
