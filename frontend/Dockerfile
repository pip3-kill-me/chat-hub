# --- Stage 1: Build the React App ---
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# This creates the optimized build in the /app/build folder
RUN npm run build

# --- Stage 2: Serve with Nginx ---
FROM nginx:stable-alpine

# Copy the static files from the build stage
COPY --from=builder /app/build /usr/share/nginx/html

# Remove the default nginx configuration
RUN rm /etc/nginx/conf.d/default.conf

# Copy our custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d

# Nginx listens on port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]