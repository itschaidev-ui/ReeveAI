FROM ubuntu:24.04
RUN apt-get update && apt-get install -y openssh-server sudo git curl \
 && mkdir /var/run/sshd
RUN useradd -m -s /bin/bash chai && \
 mkdir -p /home/chai/.ssh && \
 chmod 700 /home/chai/.ssh
RUN echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGAsylaGlyOKVxwkp15vZ/0CkYNl37sApfmCphmauO2C" > /home/chai/.ssh/authorized_keys && \
 chmod 600 /home/chai/.ssh/authorized_keys && \
 chown -R chai:chai /home/chai/.ssh
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D"]
