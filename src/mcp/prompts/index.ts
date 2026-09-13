export const SSH_TROUBLESHOOT_PROMPT = {
  name: 'ssh-troubleshoot',
  description: 'Diagnose SSH connection and authentication issues',
  arguments: [
    {
      name: 'host',
      description: 'Remote host IP or hostname',
      required: true,
    },
    {
      name: 'user',
      description: 'SSH username',
      required: true,
    },
  ],
};

export const SSH_DESKTOP_GUIDE_PROMPT = {
  name: 'ssh-desktop-launch-guide',
  description: 'Guide for launching interactive GUI windows on Windows remote desktops via Session 1 handoff',
  arguments: [
    {
      name: 'appCommand',
      description: 'Command line of the GUI app to launch (e.g. notepad.exe)',
      required: true,
    },
  ],
};
