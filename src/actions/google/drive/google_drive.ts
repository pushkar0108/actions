import * as https from "request-promise-native"

import {GaxiosResponse} from "gaxios"
import {Credentials, OAuth2Client} from "google-auth-library"
import { drive_v3, google } from "googleapis"

import * as winston from "winston"
import { HTTP_ERROR } from "../../../error_types/http_errors"
import * as Hub from "../../../hub"
import { Error, errorWith } from "../../../hub/action_response"
import Drive = drive_v3.Drive

export class GoogleDriveAction extends Hub.OAuthAction {
    name = "google_drive"
    label = "Google Drive"
    iconName = "google/drive/google_drive.svg"
    description = "Create a new file in Google Drive."
    supportedActionTypes = [Hub.ActionType.Dashboard, Hub.ActionType.Query]
    usesStreaming = true
    minimumSupportedLookerVersion = "7.3.0"
    requiredFields = []
    params = []
    mimeType: string | undefined = undefined

  async execute(request: Hub.ActionRequest) {
    const resp = new Hub.ActionResponse()

    if (!request.params.state_json) {
      resp.success = false
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
      return resp
    }

    const stateJson = JSON.parse(request.params.state_json)
    if (stateJson.tokens && stateJson.redirect) {
      const drive = await this.driveClientFromRequest(stateJson.redirect, stateJson.tokens)

      const filename = request.formParams.filename || request.suggestedFilename()
      if (!filename) {
        const error: Error = {
          http_code: HTTP_ERROR.bad_request.code,
          status_code: HTTP_ERROR.bad_request.status,
          message: `${HTTP_ERROR.bad_request.description} Error creating filename from request`,
          location: "ActionContainer",
          documentation_url: "TODO",
        }
        resp.success = false
        resp.error = error
        resp.message = error.message
        resp.webhookId = request.webhookId
        winston.error(`${error.message}`, {error, webhookId: request.webhookId})
        return resp
      }
      try {
        await this.sendData(filename, request, drive)
        resp.success = true
      } catch (e: any) {
        let error: Error = errorWith(
            HTTP_ERROR.internal,
            "Error while sending data " + e.message,
        )

        if (e.code && e.reason) {
          error = {...error, http_code: e.code, message: `${HTTP_ERROR.internal.description} ${e.reason}`}
        }

        resp.success = false
        resp.message = e.message
        resp.webhookId = request.webhookId
        resp.error = error
        winston.error(`${error.message}`, {error, webhookId: request.webhookId})
      }
    } else {
      resp.success = false
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
    }
    return resp
  }

  async form(request: Hub.ActionRequest) {

    if (request.params.state_json) {
      try {
        const stateJson = JSON.parse(request.params.state_json)
        if (stateJson.tokens && stateJson.redirect) {
          const drive = await this.driveClientFromRequest(stateJson.redirect, stateJson.tokens)

          const form = new Hub.ActionForm()
          const driveSelections = await this.getDrives(drive)
          form.fields.push({
            description: "Google Drive where your file will be saved",
            label: "Select Drive to save file",
            name: "drive",
            options: driveSelections,
            default: driveSelections[0].name,
            interactive: true,
            required: true,
            type: "select",
          })

          if (request.formParams.search !== undefined) {
            const query = this.generateQuery(request.formParams.search)
            // drive.files.list() options
            const options: any = {
              fields: "files(id,name,parents),nextPageToken",
              orderBy: "recency desc",
              pageSize: 1000,
              q: query,
              spaces: "drive",
            }
            if (request.formParams.drive !== undefined && request.formParams.drive !== "mydrive") {
              options.driveId = request.formParams.drive
              options.includeItemsFromAllDrives = true
              options.supportsAllDrives = true
              options.corpora = "drive"
            } else {
              options.corpora = "user"
            }

            async function pagedFileList(
                accumulatedFiles: drive_v3.Schema$File[],
                response: GaxiosResponse<drive_v3.Schema$FileList>): Promise<drive_v3.Schema$File[]> {
              const mergedFiles = accumulatedFiles.concat(response.data.files!)

              // When a `nextPageToken` exists, recursively call this function to get the next page.
              if (response.data.nextPageToken) {
                const pageOptions = {...options}
                pageOptions.pageToken = response.data.nextPageToken
                return pagedFileList(mergedFiles, await drive.files.list(pageOptions))
              }
              return mergedFiles
            }

            const paginatedFiles = await pagedFileList([], await drive.files.list(options).catch((reason) => {
              if (reason.status !== 401 || reason.status !== 403) {
                winston.info("No folders found", {webhookId: request.webhookId})
                // Easier to mock out the response as any.
                return Promise.resolve({data: {files: []}} as any)
              }
              winston.info(`status fetch: ${reason.status}, cannot fetch folders`, {webhookId: request.webhookId})
            }))
            const folders = paginatedFiles.filter((folder) => (
                    !(folder.id === undefined) && !(folder.name === undefined)))
                .map((folder) => ({name: folder.id!, label: folder.name!}))
            folders.unshift({name: "root", label: "Drive Root"})

            form.fields.push({
              description: "Google Drive folder where your file will be saved",
              label: "Select folder to save file",
              name: "folder",
              options: folders,
              default: folders[0].name,
              required: true,
              type: "select",
            })
            form.fields.push({
              label: "Enter a name",
              name: "filename",
              type: "string",
              required: true,
            })
          }
          // Fetch forms is to provide searching.
          form.fields.push({
            label: "Fetch Folders",
            description: "After entering text to search below, select \"Fetch Folders\"",
            name: "fetch",
            type: "select",
            required: true,
            interactive: true,
            // Need two values to be able to have two values in Looker frontend to refetch
            options: [{label: "Reset", name: "reset"}, {label: "Fetch Folders", name: "fetch"}],
          })
          form.fields.push({
            label: "Folder Name Search",
            name: "search",
            type: "string",
            required: true,
          })
          form.state = new Hub.ActionState()
          form.state.data = JSON.stringify({tokens: stateJson.tokens, redirect: stateJson.redirect})
          return form
        }
      } catch (e: any) {
        this.sanitizeGaxiosError(e)
        winston.warn(`Error fetching form. ${e.toString()}`, {webhookId: request.webhookId})
      }
    }
    return this.loginForm(request)
  }

  generateQuery(search: string) {
    let query = `mimeType='application/vnd.google-apps.folder' and trashed=false`
    if (search !== "") {
      query = query + ` and name contains '${search}'`
    }
    return query
  }

  async oauthUrl(redirectUri: string, encryptedState: string) {
    const oauth2Client = this.oauth2Client(redirectUri)
    winston.info(redirectUri)

    // generate a url that asks permissions for Google Drive scope
    const scopes = [
      "https://www.googleapis.com/auth/drive",
    ]

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      state: encryptedState,
    })
    return url.toString()
  }

  async oauthFetchInfo(urlParams: { [key: string]: string }, redirectUri: string) {
    const actionCrypto = new Hub.ActionCrypto()
    const plaintext = await actionCrypto.decrypt(urlParams.state).catch((err: string) => {
      winston.error("Encryption not correctly configured" + err)
      throw err
    })

    const tokens = await this.getAccessTokenCredentialsFromCode(redirectUri, urlParams.code)
    // Pass back context to Looker
    const payload = JSON.parse(plaintext)
    await https.post({
      url: payload.stateurl,
      body: JSON.stringify({tokens, redirect: redirectUri}),
    }).catch((_err) => { winston.error(_err.toString()) })
  }

  async oauthCheck(request: Hub.ActionRequest) {
    if (request.params.state_json) {
      const stateJson = JSON.parse(request.params.state_json)
      if (stateJson.tokens && stateJson.redirect) {
        const drive = await this.driveClientFromRequest(stateJson.redirect, stateJson.tokens)
        await drive.files.list({
          pageSize: 10,
        })
        return true
      }
    }
    return false
  }

  oauth2Client(redirectUri: string | undefined): OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      redirectUri,
    )
  }

   async sendData(filename: string, request: Hub.ActionRequest, drive: Drive) {
     const mimeType = this.getMimeType(request)
     const fileMetadata: drive_v3.Schema$File = {
       name: filename,
       mimeType,
       parents: request.formParams.folder ? [request.formParams.folder] : undefined,
     }

     return request.stream(async (readable) => {
       winston.info("Creating new file in Drive", {webhookId: request.webhookId})
       const driveParams: drive_v3.Params$Resource$Files$Create = {
         requestBody: fileMetadata,
         media: {
           body: readable,
         },
       }

       if (request.formParams.drive !== undefined && request.formParams.drive !== "mydrive") {
         driveParams.requestBody!.driveId! = request.formParams.drive
         driveParams.supportsAllDrives = true
       }

       return drive.files.create(driveParams).catch((e: any) => {
         this.sanitizeGaxiosError(e)
         winston.error(e.toString(), {webhookId: request.webhookId})
         throw e
       })
     })
   }

   async getDrives(drive: Drive) {
     const driveList = [{name: "mydrive", label: "My Drive"}]
     const drives: GaxiosResponse<drive_v3.Schema$DriveList> = await drive.drives.list({
       pageSize: 50,
     })
     if (drives.data.drives) {
       drives.data.drives.forEach((d) => {
         driveList.push({name: d.id!, label: d.name!})
       })
     }
     return driveList
   }

   getMimeType(request: Hub.ActionRequest) {
     if (this.mimeType) {return this.mimeType}
     if (request.attachment && request.attachment.mime) {return request.attachment.mime}
     switch (request.formParams.format) {
       case "csv":
         return "text/csv"
       case "xlsx":
         return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
       case "inline_json":
         return "application/json"
       case "json":
         return "application/json"
       case "json_label":
         return "application/json"
       case "json_detail":
         return "application/json"
       case "html":
         return "text/html"
       case "txt":
         return "text/plain"
       default:
         return undefined
     }
   }

  sanitizeGaxiosError(err: any) {
    const configObjs = []
    if (err.config) {
      configObjs.push(err.config)
    }
    if (err.response && err.response.config) {
      configObjs.push(err.response.config)
    }
    for (const config of configObjs) {
      for (const prop of ["data", "body"]) {
        if (config[prop]) {
          config[prop] = "[REDACTED]"
        }
      }
    }
  }

  protected async getAccessTokenCredentialsFromCode(redirect: string, code: string) {
    const client = this.oauth2Client(redirect)
    const {tokens} = await client.getToken(code)
    return tokens
  }

  protected async driveClientFromRequest(redirect: string, tokens: Credentials) {
    const client = this.oauth2Client(redirect)
    client.setCredentials(tokens)
    return google.drive({version: "v3", auth: client})
  }

  private async loginForm(request: Hub.ActionRequest) {
    const form = new Hub.ActionForm()
    form.fields = []

    const actionCrypto = new Hub.ActionCrypto()
    const jsonString = JSON.stringify({stateurl: request.params.state_url})
    const ciphertextBlob = await actionCrypto.encrypt(jsonString).catch((err: string) => {
      winston.error("Encryption not correctly configured")
      throw err
    })
    form.state = new Hub.ActionState()
    form.fields.push({
      name: "login",
      type: "oauth_link_google",
      label: "Log in",
      description: "In order to send to Google Drive, you will need to log in" +
        " once to your Google account.",
      oauth_url: `${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    })
    winston.debug(`Login form, OAuthURL${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`)
    return form
  }
}

if (process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET) {
  Hub.addAction(new GoogleDriveAction())
}
