<?php
namespace PagePoster\Bridge;

final class Rest {
    private $factory;
    private int $applicationUser=0;
    public function __construct(callable $factory) {$this->factory=$factory;}
    public function captureApplicationPassword($user,$item): void {
        if (is_object($user) && isset($user->ID,$item['uuid'])) $this->applicationUser=(int)$user->ID;
    }
    private function error(Fault $fault): \WP_Error {
        return new \WP_Error($fault->slug,$fault->getMessage(),['status'=>$fault->httpStatus]);
    }
    private function response($data,int $status=200): \WP_REST_Response {
        $response=new \WP_REST_Response($data,$status);$response->header('Cache-Control','no-store');return $response;
    }
    public function permission($request=null) {
        $user=get_current_user_id(); // Triggers core authentication before checking its method.
        if (!$user || $this->applicationUser!==$user) return $this->error(new Fault('pp_bridge_authentication','Use a WordPress Application Password.',401));
        if (!is_ssl()) return $this->error(new Fault('pp_bridge_https_required','HTTPS is required.',403));
        if (is_multisite()) return $this->error(new Fault('pp_bridge_multisite_unsupported','This Bridge version supports single-site WordPress only.',503));
        if (!current_user_can('read')) return $this->error(new Fault('pp_bridge_forbidden','Account access is required.',403));
        return true;
    }
    public function registerRoutes(): void {
        foreach ([['/status','GET','status'],['/operations','POST','operation'],
            ['/operations/(?P<id>[a-f0-9-]{36})','GET','readOperation'],['/pages/(?P<id>[1-9][0-9]*)','GET','page'],['/inspect/(?P<id>[1-9][0-9]*)','GET','inspect']] as $route) {
            register_rest_route('pageposter/v1',$route[0],['methods'=>$route[1],'callback'=>[$this,$route[2]],'permission_callback'=>[$this,'permission']]);
        }
    }
    private function canWrite(?array $post,array $input): bool {
        if ($input['kind']==='adopt') return $post && $this->canRead($post);
        if (!current_user_can('unfiltered_html')) return false;
        $type=get_post_type_object($input['postType']);if (!$type) return false;
        if ($input['status']==='publish' && !current_user_can($type->cap->publish_posts)) return false;
        if ($post) {wp_cache_delete((int)$post['ID'],'posts');return current_user_can('edit_post',(int)$post['ID']);}
        return current_user_can($type->cap->create_posts);
    }
    private function canRead(array $post): bool {
        if (!current_user_can('unfiltered_html')) return false;
        wp_cache_delete((int)$post['ID'],'posts');return current_user_can('edit_post',(int)$post['ID']);
    }
    private function call(callable $callback) {
        $permission=$this->permission();if (is_wp_error($permission)) return $permission;
        $db=null;
        try {$db=($this->factory)();return $callback($db);}
        catch (Fault $error) {return $this->error($error);}
        catch (\Throwable $error) {return $this->error(new Fault('pp_bridge_unavailable','Bridge storage is unavailable.',503));}
        finally {if ($db) {try {$db->close();} catch (\Throwable $ignored) {}}}
    }
    private function cleanLinksVersion(): string {return defined('PagePoster_Clean_Links::VERSION') ? (string)\PagePoster_Clean_Links::VERSION : ''; }
    private function cleanLinksFeatures(): array {return defined('PagePoster_Clean_Links::FEATURES') && is_array(\PagePoster_Clean_Links::FEATURES) ? \PagePoster_Clean_Links::FEATURES : []; }
    private function cleanLinksActive(): bool {
        return in_array('pageposter-clean-links/pageposter-clean-links.php', (array)get_option('active_plugins', []), true) &&
            class_exists('\PagePoster_Clean_Links', false) && is_callable(['\PagePoster_Clean_Links', 'is_pageposter_content']) &&
            $this->cleanLinksVersion()==='1.1.1' && !array_diff(['contact-schemes','exact-wrapper-boundary'],$this->cleanLinksFeatures());
    }
    private function packageHashes(string $root): ?array {
        // Hash the installed bytes, including this reporter. Expected hashes live only in the client ZIPs.
        try {
            if (!is_dir($root) || is_link($root)) return null;
            $files=[];$base=rtrim($root,'/\\').DIRECTORY_SEPARATOR;
            $iterator=new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root,\FilesystemIterator::SKIP_DOTS));
            foreach ($iterator as $file) {
                if ($file->isLink()) return null;
                if (!$file->isFile() || substr($file->getFilename(),-4)!=='.php') continue;
                if (count($files)>=100 || $file->getSize()>2097152 || !$file->isReadable()) return null;
                $relative=str_replace(DIRECTORY_SEPARATOR,'/',substr($file->getPathname(),strlen($base)));
                $hash=hash_file('sha256',$file->getPathname());if ($hash===false) return null;
                $files[$relative]=$hash;
            }
            ksort($files,SORT_STRING);return $files ?: null;
        } catch (\Throwable $error) {return null;}
    }
    private function packageIntegrity(): array {
        $root=dirname(__DIR__);$plugins=defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : dirname($root);
        return ['algorithm'=>'sha256','bridge'=>$this->packageHashes($root),'cleanLinks'=>$this->packageHashes($plugins.'/pageposter-clean-links')];
    }
    public function status($request) {
        $permission=$this->permission();if (is_wp_error($permission)) return $permission;
        $db=null;$ready=false;$reasons=[];
        try {$db=($this->factory)();$ready=$db->ready();$reasons=$db->reasons();}
        catch (\Throwable $error) {$reasons[]='A dedicated InnoDB connection is unavailable.';}
        finally {if ($db) {try {$db->close();} catch (\Throwable $ignored) {}}}
        $cleanLinks=$this->cleanLinksActive();
        if (!$cleanLinks) $reasons[]='Install and activate both PagePoster Clean Links and PagePoster Bridge using their supplied ZIPs.';
        $ready=$ready && $cleanLinks;
        $create=current_user_can('unfiltered_html') && (current_user_can('edit_pages') || current_user_can('edit_posts'));
        return $this->response([
            'packageIntegrity'=>$this->packageIntegrity(),'version'=>Contract::VERSION,'schemaVersion'=>1,'ready'=>$ready,'cleanLinksActive'=>$cleanLinks,'cleanLinksVersion'=>$this->cleanLinksVersion(),'cleanLinksFeatures'=>$this->cleanLinksFeatures(),
            'capabilities'=>['create'=>$ready&&$create,'update'=>$ready&&$create,'atomicCas'=>$ready,'idempotentCreate'=>$ready,'adopt'=>$ready&&$create,'inspect'=>true],
            'limitations'=>array_merge($reasons,[
                'Only Bridge-created or explicitly adopted marked static pages/posts are managed.',
                'WordPress save/transition hooks and taxonomy automation are not invoked.',
                'Later manual saves require a fresh snapshot before the next Bridge update.',
                'Public rendering, cache freshness and plugin compatibility need separate verification.'
            ])
        ]);
    }
    public function operation($request) {
        return $this->call(function($db)use($request) {
            if (!$this->cleanLinksActive()) throw new Fault('pp_bridge_clean_links_required','Install and activate PagePoster Clean Links before writing pages.',503);
            if (!preg_match('/^application\/json(?:\s*;|$)/i',$request->get_header('content-type'))) throw new Fault('pp_bridge_media_type','Use application/json.',415);
            if (strlen($request->get_body())>1200000) throw new Fault('pp_bridge_body_too_large','Request body is too large.',413);
            $input=$request->get_json_params();
            if (!is_array($input)) throw new Fault('pp_bridge_validation','A JSON operation object is required.',400);
            [$status,$result]=$this->executeInput($db,$input);
            return $this->response($result,$status);
        });
    }
    // Shared writer; callers must authenticate their transport before opening storage.
    public function executeInput($db,array $input): array {
            if (!$this->cleanLinksActive()) throw new Fault('pp_bridge_clean_links_required','Install and activate PagePoster Clean Links before writing pages.',503);
            $engine=new Engine($db);
            $result=$engine->execute($input,get_current_user_id(),function($post,$data){return $this->canWrite($post,$data);});
            if ($result['state']==='completed') {
                // Cache work is outside the durable transaction and may safely repeat on a replay.
                try {
                    clean_post_cache($result['postId']);
                    if (function_exists('wp_cache_set_posts_last_changed')) wp_cache_set_posts_last_changed();
                    foreach (['page','post'] as $type) wp_cache_delete('posts-'.$type,'counts');
                } catch (\Throwable $ignored) {$result['warnings'][]='Database commit completed; cache invalidation requires verification.';}
            }
            $status=$result['state']==='conflict'?409:(!$result['replayed']&&$result['kind']==='create'?201:200);
            return [$status,$result];
    }
    public function readOperation($request) {
        return $this->call(function($db)use($request) {
            $id=Contract::operationId($request->get_param('id'));$record=$db->getOperation($id);
            if (!$record) throw new Fault('pp_bridge_operation_not_found','No committed operation is visible. An in-flight transaction may still exist.',404);
            if ((int)$record['owner_id']!==get_current_user_id()) throw new Fault('pp_bridge_operation_owner','This operation belongs to another account.',403);
            if (!$record['result_json']) throw new Fault('pp_bridge_uncertain','This operation requires reconciliation.',503);
            $result=json_decode($record['result_json'],true,512,JSON_THROW_ON_ERROR);$post=$db->readPost((int)$result['postId']);
            if (!$post || ($result['state']==='completed' && !$db->isManaged((int)$result['postId'])) || !$this->canRead($post)) throw new Fault('pp_bridge_forbidden','Current permission for this managed post is required.',403);
            $result['replayed']=true;return $this->response($result);
        });
    }
    public function inspect($request) {return $this->readPage($request,false);}
    public function page($request) {return $this->readPage($request,true);}
    private function readPage($request,bool $managedOnly) {
        return $this->call(function($db)use($request,$managedOnly) {
            $id=filter_var($request->get_param('id'),FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
            if (!$id) throw new Fault('pp_bridge_validation','A positive page identity is required.',400);
            $post=$db->readPost($id);if (!$post) throw new Fault('pp_bridge_not_found','Post was not found.',404);
            if (($managedOnly && !$db->isManaged($id)) || !in_array($post['post_type'],['page','post'],true) || !$this->canRead($post)) throw new Fault('pp_bridge_forbidden','Only editable Bridge-managed posts are available.',403);
            return $this->response([
                'postId'=>$id,'postType'=>$post['post_type'],'title'=>$post['post_title'],'content'=>$post['post_content'],
                'status'=>$post['post_status'],'contentHash'=>Contract::contentHash($post),'modifiedGmt'=>$post['post_modified_gmt'],
                'url'=>$db->url($post),'managed'=>$db->isManaged($id),'canEdit'=>true
            ]);
        });
    }
}
