FROM node:20-alpine AS build

ARG AIOS_VERSION=dev
ENV VITE_APP_VERSION=${AIOS_VERSION}

# URL of the goku-core (runtime) frontend — Studio redirects here for login.
# Pass at build time: docker build --build-arg VITE_RUNTIME_URL=https://core.example.com
ARG VITE_RUNTIME_URL=http://localhost:5106
ENV VITE_RUNTIME_URL=${VITE_RUNTIME_URL}

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback: redirect all routes to index.html.
# The GCP load balancer probes GET / every few seconds with UA "GoogleHC/1.0";
# those probes were the entire access log of one frontend and 17% of another, so
# they are excluded from access_log. `map` is valid here because conf.d/*.conf is
# included from within the stock nginx.conf `http` block.
RUN printf 'map $http_user_agent $loggable {\n  default 1;\n  ~*GoogleHC 0;\n}\nserver {\n  listen 80;\n  root /usr/share/nginx/html;\n  access_log /var/log/nginx/access.log combined if=$loggable;\n  location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
