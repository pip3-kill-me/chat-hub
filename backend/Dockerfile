# Use a lightweight Node.js image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files and install dependencies
# This caches the node_modules layer for faster rebuilds
COPY package*.json ./
RUN npm install --only=production

# Copy the rest of your backend source code
COPY . .

# Your app runs on port 3001 inside the container
EXPOSE 3001

# The command to start your server
CMD [ "node", "server.js" ]